import { describe, expect, it } from "vitest";
import { decodeEncodedWords } from "../src/encoded-word.js";
import { decodeQuotedPrintable, decodeBase64 } from "../src/quoted-printable.js";
import { normalizeCharset, decodeBytes, decodeUtf16Le } from "../src/charset.js";
import { htmlToText, decodeEntities } from "../src/html-to-text.js";

describe("decodeEncodedWords", () => {
  it("decodes Base64 and Quoted-Printable words", () => {
    expect(decodeEncodedWords("=?UTF-8?B?5pel5pys?=")).toBe("日本");
    expect(decodeEncodedWords("=?UTF-8?Q?=E6=97=A5?=")).toBe("日");
  });

  it("joins adjacent encoded-words without the separating whitespace", () => {
    expect(decodeEncodedWords("=?UTF-8?B?5pel?= =?UTF-8?B?5pys?=")).toBe("日本");
  });

  it("preserves surrounding plain text and the Q underscore-as-space", () => {
    expect(decodeEncodedWords("Re: =?UTF-8?Q?a_b?= (x)")).toBe("Re: a b (x)");
  });
});

describe("quoted-printable and base64", () => {
  it("decodes =XX, soft breaks, and underscores when asked", () => {
    expect(new TextDecoder().decode(decodeQuotedPrintable("a=20b=E2=98=83"))).toBe("a b☃");
    expect(new TextDecoder().decode(decodeQuotedPrintable("line=\r\nwrap"))).toBe("linewrap");
    expect(new TextDecoder().decode(decodeQuotedPrintable("a_b", true))).toBe("a b");
  });

  it("decodes base64 ignoring whitespace", () => {
    expect(new TextDecoder().decode(decodeBase64("5pel\n5pys"))).toBe("日本");
  });
});

describe("charset", () => {
  it("normalizes common labels", () => {
    expect(normalizeCharset("UTF8")).toBe("utf-8");
    expect(normalizeCharset("us-ascii")).toBe("utf-8");
    expect(normalizeCharset('"Shift_JIS"')).toBe("shift_jis");
    expect(normalizeCharset("cp932")).toBe("shift_jis");
    expect(normalizeCharset(undefined)).toBe("utf-8");
  });

  it("decodes bytes and utf-16le", () => {
    expect(decodeBytes(new Uint8Array([0xe6, 0x97, 0xa5]), "utf-8")).toBe("日");
    expect(decodeUtf16Le(new Uint8Array([0xe5, 0x65]))).toBe("日"); // U+65E5 little-endian
  });
});

describe("htmlToText", () => {
  it("decodes entities including numeric ones", () => {
    expect(decodeEntities("a&amp;b&#65;&#x42;&yen;")).toBe("a&bAB¥");
  });

  it("breaks on block tags, drops scripts/styles, collapses blanks", () => {
    const html =
      "<style>.x{}</style><p>Hello</p><script>bad()</script><div>World<br>Line</div>";
    const text = htmlToText(html);
    expect(text).toContain("Hello");
    expect(text).toContain("World");
    expect(text).toContain("Line");
    expect(text).not.toContain("bad()");
    expect(text).not.toContain(".x{}");
    expect(text).not.toMatch(/\n{3,}/);
  });
});
