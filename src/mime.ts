/** Parse a MIME (.eml) message into the normalized Mail model. */
import { decodeBytes } from "./charset.js";
import { parseHeaderBlock, splitHeaderBody } from "./headers.js";
import { htmlToText } from "./html-to-text.js";
import { decodeBase64, decodeQuotedPrintable } from "./quoted-printable.js";
import { headerValue, type Attachment, type Header, type Mail } from "./mail.js";

/**
 * A byte-preserving 1:1 view of the buffer (each byte -> one char code 0-255).
 * TextDecoder("latin1") maps to windows-1252 and mangles 0x80-0x9F, so build it
 * by hand to keep the structural parse lossless.
 */
function bytesToBinaryString(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return s;
}

/** Reinterpret a byte-preserving binary string back to the original bytes. */
function latin1ToBytes(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
  return bytes;
}

/** Match every `attribute=value` pair in a structured header value. */
const PARAM_PAIR = /([!#$%&'*+.0-9A-Z^_`a-z{|}~-]+)\s*=\s*("([^"]*)"|[^;]*)/g;

/** Percent-decode an RFC 2231 value to bytes (non-escaped chars pass through). */
function percentDecodeToBytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(s.charCodeAt(i) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/**
 * Extract the value of a Content-Type / Content-Disposition parameter.
 *
 * Understands, in order of precedence:
 * - RFC 2231 extended form: `name*=charset'lang'percent-encoded`
 * - RFC 2231 continuations: `name*0*=...; name*1=...` (assembled in order;
 *   the charset prefix is taken from section 0, and percent-decoded bytes
 *   from all sections are concatenated before charset decoding so multibyte
 *   sequences may span section boundaries)
 * - Plain form: `name=value` / `name="value"`
 *
 * An empty or unknown charset label is decoded as UTF-8 best-effort (see
 * decodeBytes), which also covers plain ASCII values.
 */
function param(headerLine: string, name: string): string | undefined {
  const base = name.toLowerCase();
  const contRe = new RegExp(`^${base}\\*(\\d+)(\\*)?$`, "i");
  let plain: string | undefined;
  let extended: string | undefined;
  const sections = new Map<number, { encoded: boolean; value: string }>();

  PARAM_PAIR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PARAM_PAIR.exec(headerLine)) !== null) {
    const key = m[1]!.toLowerCase();
    const value = m[3] ?? m[2]!.trim();
    if (key === base) {
      plain ??= value;
      continue;
    }
    if (key === `${base}*`) {
      extended ??= value;
      continue;
    }
    const cont = contRe.exec(m[1]!);
    if (cont) {
      const idx = parseInt(cont[1]!, 10);
      if (!sections.has(idx)) sections.set(idx, { encoded: cont[2] !== undefined, value });
    }
  }

  if (extended !== undefined) {
    // charset'language'percent-encoded; a malformed value (no apostrophes)
    // is treated as percent-encoded UTF-8.
    const ext = /^([^']*)'[^']*'([\s\S]*)$/.exec(extended);
    const charset = ext ? ext[1]! : "";
    const encoded = ext ? ext[2]! : extended;
    return decodeBytes(percentDecodeToBytes(encoded), charset || undefined);
  }

  if (sections.size > 0) {
    const order = [...sections.keys()].sort((a, b) => a - b);
    let charset: string | undefined;
    const chunks: Uint8Array[] = [];
    for (const idx of order) {
      const section = sections.get(idx)!;
      let value = section.value;
      if (section.encoded) {
        if (idx === 0) {
          const ext = /^([^']*)'[^']*'([\s\S]*)$/.exec(value);
          if (ext) {
            charset = ext[1]! || undefined;
            value = ext[2]!;
          }
        }
        chunks.push(percentDecodeToBytes(value));
      } else {
        // Literal sections are ASCII per RFC 2231; keep their byte values.
        const bytes = new Uint8Array(value.length);
        for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i) & 0xff;
        chunks.push(bytes);
      }
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      joined.set(c, offset);
      offset += c.length;
    }
    return decodeBytes(joined, charset);
  }

  return plain;
}

interface Accum {
  text?: string;
  html?: string;
  attachments: Attachment[];
}

/** Decode a leaf part's body (latin1 string) to bytes per its transfer encoding. */
function decodePartBytes(bodyLatin1: string, cte: string): Uint8Array {
  const enc = cte.trim().toLowerCase();
  if (enc === "base64") return decodeBase64(bodyLatin1);
  if (enc === "quoted-printable") return decodeQuotedPrintable(bodyLatin1);
  return latin1ToBytes(bodyLatin1); // 7bit / 8bit / binary / none.
}

/** Split a multipart body (latin1) into its child parts by boundary. */
function splitMultipart(body: string, boundary: string): string[] {
  const delim = `--${boundary}`;
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const parts: string[] = [];
  let buf: string[] | null = null;
  for (const line of lines) {
    if (line === delim || line === `${delim}--`) {
      if (buf) parts.push(buf.join("\n"));
      buf = line === `${delim}--` ? null : [];
      continue;
    }
    if (buf) buf.push(line);
  }
  return parts;
}

function walk(headers: Header[], body: string, acc: Accum): void {
  const contentType = headerValue(headers, "content-type") ?? "text/plain";
  const mediaType = contentType.split(";")[0]!.trim().toLowerCase();
  const disposition = headerValue(headers, "content-disposition") ?? "";
  const cte = headerValue(headers, "content-transfer-encoding") ?? "";

  if (mediaType.startsWith("multipart/")) {
    const boundary = param(contentType, "boundary");
    if (!boundary) return;
    for (const raw of splitMultipart(body, boundary)) {
      const { header, body: childBody } = splitHeaderBody(raw);
      walk(parseHeaderBlock(header), childBody, acc);
    }
    return;
  }

  const filename = (param(disposition, "filename") || param(contentType, "name")) || undefined;
  const isAttachment = /attachment/i.test(disposition) || (filename !== undefined && !mediaType.startsWith("text/"));
  const bytes = decodePartBytes(body, cte);

  if (isAttachment) {
    // A declared attachment must never vanish just because it has no name.
    acc.attachments.push({ filename: filename ?? "(unnamed)", contentType: mediaType, size: bytes.length, content: bytes });
    return;
  }

  const charset = param(contentType, "charset");
  const text = decodeBytes(bytes, charset);
  if (mediaType === "text/html") {
    if (acc.html === undefined) acc.html = text;
  } else if (mediaType === "text/plain") {
    if (acc.text === undefined) acc.text = text;
  } else if (filename) {
    acc.attachments.push({ filename, contentType: mediaType, size: bytes.length, content: bytes });
  }
}

/** Parse .eml bytes into a Mail. */
export function parseEml(input: Uint8Array): Mail {
  // A byte-preserving view keeps every byte 1:1 for structural parsing.
  const raw = bytesToBinaryString(input);
  const { header, body } = splitHeaderBody(raw);
  const headers = parseHeaderBlock(header);

  const acc: Accum = { attachments: [] };
  walk(headers, body, acc);

  if (acc.text === undefined && acc.html !== undefined) {
    acc.text = htmlToText(acc.html);
  }

  return {
    format: "eml",
    headers,
    subject: headerValue(headers, "subject"),
    from: headerValue(headers, "from"),
    to: headerValue(headers, "to"),
    cc: headerValue(headers, "cc"),
    date: headerValue(headers, "date"),
    text: acc.text,
    html: acc.html,
    attachments: acc.attachments,
  };
}
