import { lstat, mkdtemp, readdir, readFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEml } from "../src/mime.js";
import { extensionForContentType, sanitizeFilename, saveAttachments } from "../src/save.js";
import type { Attachment } from "../src/mail.js";

function att(filename: string, data: string, contentType?: string): Attachment {
  const content = new Uint8Array(Buffer.from(data, "utf8"));
  return { filename, contentType, size: content.length, content };
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mailpeek-save-"));
}

describe("sanitizeFilename", () => {
  it("neutralizes path separators and traversal attempts", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(sanitizeFilename("..\\..\\boot.ini")).toBe(".._.._boot.ini");
    expect(sanitizeFilename("..")).toBe("");
    expect(sanitizeFilename(".")).toBe("");
  });

  it("neutralizes percent-encoded separators like ..%2F..", () => {
    const s = sanitizeFilename("..%2F..");
    expect(s).toBe(".._"); // trailing dots are also trimmed (Windows rule)
    expect(s).not.toContain("/");
    expect(sanitizeFilename("a%5Cb.txt")).toBe("a_b.txt");
  });

  it("strips control characters, including CRLF", () => {
    expect(sanitizeFilename("evil\r\nname.txt")).toBe("evilname.txt");
    expect(sanitizeFilename("a b\tc.bin")).toBe("a bc.bin");
  });

  it("returns empty for names with nothing left", () => {
    expect(sanitizeFilename("")).toBe("");
    expect(sanitizeFilename("  \r\n ")).toBe("");
    expect(sanitizeFilename("... ")).toBe("");
  });

  it("replaces Windows-forbidden characters and trims trailing dots/spaces", () => {
    expect(sanitizeFilename('a<b>c:d"e|f?g*h.txt')).toBe("a_b_c_d_e_f_g_h.txt");
    expect(sanitizeFilename("report.txt. . .")).toBe("report.txt");
    expect(sanitizeFilename("trail.")).toBe("trail");
  });

  it("prefixes Windows-reserved device names, with or without an extension", () => {
    expect(sanitizeFilename("CON")).toBe("_CON");
    expect(sanitizeFilename("con.txt")).toBe("_con.txt");
    expect(sanitizeFilename("Com1.csv")).toBe("_Com1.csv");
    expect(sanitizeFilename("lpt9")).toBe("_lpt9");
    expect(sanitizeFilename("COM10.txt")).toBe("COM10.txt"); // only COM1-9 are reserved
    expect(sanitizeFilename("console.txt")).toBe("console.txt");
  });

  it("truncates very long names to 200 UTF-8 bytes, preserving the extension", () => {
    const out = sanitizeFilename(`${"a".repeat(300)}.pdf`);
    expect(out.endsWith(".pdf")).toBe(true);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(200);

    // Multibyte names are cut on a code point boundary, never inside one.
    const outJp = sanitizeFilename(`${"あ".repeat(150)}.txt`);
    expect(outJp.endsWith(".txt")).toBe(true);
    expect(Buffer.byteLength(outJp, "utf8")).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(outJp, "utf8")).toBeGreaterThan(190);
    expect(outJp).toBe(`${"あ".repeat(65)}.txt`);

    // An absurdly long "extension" is not preserved verbatim.
    const noExt = sanitizeFilename(`x.${"e".repeat(300)}`);
    expect(Buffer.byteLength(noExt, "utf8")).toBeLessThanOrEqual(200);
  });
});

describe("extensionForContentType", () => {
  it("maps common media types and falls back to .bin", () => {
    expect(extensionForContentType("application/pdf")).toBe(".pdf");
    expect(extensionForContentType("text/plain; charset=utf-8")).toBe(".txt");
    expect(extensionForContentType("application/x-unknown")).toBe(".bin");
    expect(extensionForContentType(undefined)).toBe(".bin");
  });
});

describe("saveAttachments", () => {
  it("suffixes -1, -2 when names collide within one message", async () => {
    const dir = await tempDir();
    const written = await saveAttachments(
      [att("a.txt", "one"), att("a.txt", "two"), att("a.txt", "three")],
      dir,
    );
    expect(written.map((w) => w.path)).toEqual([
      join(dir, "a.txt"),
      join(dir, "a-1.txt"),
      join(dir, "a-2.txt"),
    ]);
    expect(await readFile(join(dir, "a-1.txt"), "utf8")).toBe("two");
  });

  it("gives unnamed attachments a generic name with a guessed extension", async () => {
    const dir = await tempDir();
    const written = await saveAttachments(
      [att("(unnamed)", "pdf-bytes", "application/pdf"), att("(unnamed)", "blob")],
      dir,
    );
    expect(written.map((w) => w.path)).toEqual([
      join(dir, "attachment.pdf"),
      join(dir, "attachment.bin"),
    ]);
  });

  it("writes a sanitized name for a traversal-style filename", async () => {
    const dir = await tempDir();
    const written = await saveAttachments([att("../escape\r\n.txt", "x")], dir);
    expect(written).toHaveLength(1);
    expect(written[0]!.path).toBe(join(dir, ".._escape.txt"));
    expect(await readdir(dir)).toEqual([".._escape.txt"]);
  });

  it("refuses to overwrite an existing file unless force is set", async () => {
    const dir = await tempDir();
    await saveAttachments([att("dup.txt", "first")], dir);
    await expect(saveAttachments([att("dup.txt", "second")], dir)).rejects.toThrow(/--force/);
    expect(await readFile(join(dir, "dup.txt"), "utf8")).toBe("first");

    await saveAttachments([att("dup.txt", "second")], dir, { force: true });
    expect(await readFile(join(dir, "dup.txt"), "utf8")).toBe("second");
  });

  it("does not follow a pre-planted dangling symlink without force", async () => {
    const dir = await tempDir();
    const outside = join(await tempDir(), "pwned.txt");
    await symlink(outside, join(dir, "trap.txt"));

    await expect(saveAttachments([att("trap.txt", "payload")], dir)).rejects.toThrow(/--force/);
    expect(existsSync(outside)).toBe(false);
  });

  it("replaces (never follows) an existing symlink when force is set", async () => {
    const dir = await tempDir();
    const outside = join(await tempDir(), "pwned.txt");
    await symlink(outside, join(dir, "trap.txt"));

    await saveAttachments([att("trap.txt", "payload")], dir, { force: true });
    expect(existsSync(outside)).toBe(false);
    expect((await lstat(join(dir, "trap.txt"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(dir, "trap.txt"), "utf8")).toBe("payload");
  });

  it("saves an attachment with a ~300-character filename instead of failing", async () => {
    const dir = await tempDir();
    const written = await saveAttachments(
      [att("short.txt", "first"), att(`${"a".repeat(300)}.txt`, "long")],
      dir,
    );
    expect(written).toHaveLength(2);
    expect(await readdir(dir)).toHaveLength(2);
    expect(await readFile(written[1]!.path, "utf8")).toBe("long");
  });

  it("saves only the selected 1-based attachment with the only option", async () => {
    const dir = await tempDir();
    const written = await saveAttachments([att("a.txt", "one"), att("b.txt", "two")], dir, {
      only: 2,
    });
    expect(written.map((w) => w.path)).toEqual([join(dir, "b.txt")]);
    expect(await readdir(dir)).toEqual(["b.txt"]);
  });

  it("rejects an out-of-range only index", async () => {
    const dir = await tempDir();
    await expect(saveAttachments([att("a.txt", "one")], dir, { only: 2 })).rejects.toThrow(
      /out of range/,
    );
  });

  it("writes a fixture .eml attachment end to end", async () => {
    const raw = await readFile(new URL("./fixtures/attachment.eml", import.meta.url));
    const mail = parseEml(new Uint8Array(raw));
    expect(mail.attachments).toHaveLength(1);

    const dir = await tempDir();
    const written = await saveAttachments(mail.attachments, dir);
    expect(written).toEqual([{ path: join(dir, "notes.txt"), size: 19 }]);
    expect(await readFile(join(dir, "notes.txt"), "utf8")).toBe("Hello, attachment!\n");
  });
});
