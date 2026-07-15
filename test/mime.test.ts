import { describe, expect, it } from "vitest";
import { parseHeaderBlock, splitHeaderBody } from "../src/headers.js";
import { parseEml } from "../src/mime.js";
import { renderText, renderJson } from "../src/render.js";
import { isCfb, parseCfb } from "../src/cfb.js";

describe("parseHeaderBlock", () => {
  it("unfolds continuation lines and decodes encoded-words", () => {
    const raw = "Subject: =?UTF-8?B?5pel5pys?=\r\nReceived: a\r\n\tb\r\nReceived: second";
    const headers = parseHeaderBlock(raw);
    expect(headers.find((h) => h.name === "Subject")?.value).toBe("日本");
    expect(headers.find((h) => h.name === "Received")?.value).toBe("a b");
    expect(headers.filter((h) => h.name === "Received")).toHaveLength(2);
  });
});

describe("splitHeaderBody", () => {
  it("splits at the first blank line and normalizes CRLF", () => {
    const { header, body } = splitHeaderBody("A: 1\r\nB: 2\r\n\r\nbody\r\nline");
    expect(header).toBe("A: 1\nB: 2");
    expect(body).toBe("body\nline");
  });
});

const CRLF = "\r\n";
function buildEml(parts: string[]): Uint8Array {
  return new Uint8Array(Buffer.from(parts.join(CRLF), "utf8"));
}

describe("parseEml", () => {
  const html = "<p>Hi <b>there</b></p>";
  const eml = buildEml([
    "Subject: =?UTF-8?B?5pel5pys?=",
    "From: Alice <alice@example.com>",
    "To: bob@example.com",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="BB"',
    "",
    "preamble ignored",
    "--BB",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Hello=20World=E2=98=83",
    "--BB",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html, "utf8").toString("base64"),
    "--BB",
    'Content-Type: application/octet-stream; name="data.bin"',
    "Content-Disposition: attachment; filename=\"data.bin\"",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("payload", "utf8").toString("base64"),
    "--BB--",
    "epilogue",
  ]);

  it("extracts headers, both bodies, and attachments", () => {
    const mail = parseEml(eml);
    expect(mail.subject).toBe("日本");
    expect(mail.from).toBe("Alice <alice@example.com>");
    expect(mail.to).toBe("bob@example.com");
    expect(mail.text).toBe("Hello World☃");
    expect(mail.html).toBe("<p>Hi <b>there</b></p>");
    expect(mail.attachments).toEqual([
      {
        filename: "data.bin",
        contentType: "application/octet-stream",
        size: 7,
        content: new Uint8Array(Buffer.from("payload", "utf8")),
      },
    ]);
  });

  it("retains the decoded attachment bytes", () => {
    const mail = parseEml(eml);
    expect(Buffer.from(mail.attachments[0]!.content!).toString("utf8")).toBe("payload");
  });

  it("derives text from html when there is no text/plain part", () => {
    const htmlOnly = buildEml([
      "Subject: x",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>One</p><p>Two</p>",
    ]);
    const mail = parseEml(htmlOnly);
    expect(mail.text).toContain("One");
    expect(mail.text).toContain("Two");
    expect(mail.html).toBe("<p>One</p><p>Two</p>");
  });

  function attachmentEml(partHeaders: string[]): Uint8Array {
    return buildEml([
      "Subject: x",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="BB"',
      "",
      "--BB",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "body",
      "--BB",
      ...partHeaders,
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("payload", "utf8").toString("base64"),
      "--BB--",
    ]);
  }

  it("keeps plain quoted filenames working", () => {
    const mail = parseEml(
      attachmentEml([
        "Content-Type: application/pdf",
        'Content-Disposition: attachment; filename="report.pdf"',
      ]),
    );
    expect(mail.attachments).toMatchObject([
      { filename: "report.pdf", contentType: "application/pdf", size: 7 },
    ]);
  });

  it("decodes RFC 2047 encoded-word filenames (regression)", () => {
    const mail = parseEml(
      attachmentEml([
        "Content-Type: application/pdf",
        'Content-Disposition: attachment; filename="=?UTF-8?B?5pel5pys6Kqe?=.pdf"',
      ]),
    );
    expect(mail.attachments[0]?.filename).toBe("日本語.pdf");
  });

  it("decodes RFC 2231 extended filename* with UTF-8 Japanese", () => {
    const mail = parseEml(
      attachmentEml([
        "Content-Type: application/pdf",
        "Content-Disposition: attachment; filename*=UTF-8''%E8%AB%8B%E6%B1%82%E6%9B%B8.pdf",
      ]),
    );
    expect(mail.attachments[0]?.filename).toBe("請求書.pdf");
  });

  it("prefers the extended form when both filename and filename* are present", () => {
    const mail = parseEml(
      attachmentEml([
        "Content-Type: application/pdf",
        "Content-Disposition: attachment; filename=\"fallback.pdf\"; filename*=UTF-8''%E6%97%A5%E6%9C%AC.pdf",
      ]),
    );
    expect(mail.attachments[0]?.filename).toBe("日本.pdf");
  });

  it("assembles RFC 2231 continuations, including multibyte splits across sections", () => {
    // The UTF-8 bytes of the second kanji are split across sections 0 and 1.
    const mail = parseEml(
      attachmentEml([
        "Content-Type: application/pdf",
        "Content-Disposition: attachment; filename*0*=UTF-8''%E6%97%A5%E6%9C; filename*1*=%AC%E8%AA%9E; filename*2=\".pdf\"",
      ]),
    );
    expect(mail.attachments[0]?.filename).toBe("日本語.pdf");
  });

  it("assembles unstarred quoted continuations", () => {
    const mail = parseEml(
      attachmentEml([
        "Content-Type: application/octet-stream",
        'Content-Disposition: attachment; filename*0="long-name"; filename*1="-part.bin"',
      ]),
    );
    expect(mail.attachments[0]?.filename).toBe("long-name-part.bin");
  });

  it("lists an attachment with no recoverable name as (unnamed)", () => {
    const mail = parseEml(
      attachmentEml([
        "Content-Type: application/octet-stream",
        "Content-Disposition: attachment",
      ]),
    );
    expect(mail.attachments).toMatchObject([
      { filename: "(unnamed)", contentType: "application/octet-stream", size: 7 },
    ]);
  });

  it("renders text and json views", () => {
    const mail = parseEml(eml);
    const text = renderText(mail, { color: false, allHeaders: false });
    expect(text).toContain("Subject: 日本");
    expect(text).toContain("Hello World☃");
    expect(text).toContain("attachments (1)");
    const json = JSON.parse(renderJson(mail));
    expect(json.subject).toBe("日本");
    // JSON output carries attachment metadata only, never the raw bytes.
    expect(json.attachments).toEqual([
      { filename: "data.bin", contentType: "application/octet-stream", size: 7 },
    ]);
  });
});

describe("isCfb / parseCfb", () => {
  it("detects the compound-file signature", () => {
    expect(isCfb(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe(true);
    expect(isCfb(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe(false);
  });

  it("rejects a non-compound buffer", () => {
    expect(() => parseCfb(new Uint8Array([1, 2, 3, 4]))).toThrow(/compound file/);
  });
});
