import { describe, expect, it } from "vitest";
import { renderText } from "../src/render.js";
import { parseEml } from "../src/mime.js";
import { stringWidth } from "../src/width.js";
import type { Mail } from "../src/mail.js";

/** Display column at which `marker` (ASCII) starts within a rendered line. */
function columnOf(line: string, marker: string): number {
  const idx = line.indexOf(marker);
  return idx < 0 ? -1 : stringWidth(line.slice(0, idx));
}

const opts = { color: false, allHeaders: false };

describe("renderText header column", () => {
  it("aligns the label column with ASCII header values", () => {
    const mail: Mail = { format: "eml", headers: [], from: "Bob <bob@example.com>", subject: "Hi", attachments: [] };
    const lines = renderText(mail, opts).split("\n");
    const from = lines.find((l) => l.startsWith("From"))!;
    expect(columnOf(from, "Bob")).toBe(9);
  });

  it("keeps the label column aligned when header values are CJK", () => {
    const mail: Mail = {
      format: "eml",
      headers: [],
      date: "2026-07-15",
      from: "山田太郎 <yamada@example.com>",
      subject: "議事録の共有",
      text: "本文です",
      attachments: [],
    };
    const lines = renderText(mail, opts).split("\n");
    const from = lines.find((l) => l.startsWith("From"))!;
    const subject = lines.find((l) => l.startsWith("Subject"))!;
    // Values start at display column 9 no matter the script of the value.
    expect(columnOf(from, "山田")).toBe(9);
    expect(columnOf(subject, "議事録")).toBe(9);
  });
});

describe("renderText end-to-end with a Japanese subject", () => {
  it("decodes an encoded-word subject and renders it aligned", () => {
    const subject = "議事録の共有";
    const b64 = Buffer.from(subject, "utf8").toString("base64");
    const eml = [
      "Date: Wed, 15 Jul 2026 09:00:00 +0900",
      "From: Alice <alice@example.com>",
      `Subject: =?UTF-8?B?${b64}?=`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "本文の一行目",
      "",
    ].join("\r\n");
    const mail = parseEml(new TextEncoder().encode(eml));
    expect(mail.subject).toBe(subject);
    const out = renderText(mail, opts);
    expect(out).toContain(subject);
    const subjLine = out.split("\n").find((l) => l.startsWith("Subject"))!;
    expect(columnOf(subjLine, "議事録")).toBe(9);
  });
});
