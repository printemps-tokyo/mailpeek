/** Render a parsed Mail as human-readable text or JSON. */
import type { Mail } from "./mail.js";

const KEY_HEADERS = ["Date", "From", "To", "Cc", "Subject"];

interface RenderOptions {
  color: boolean;
  /** Show every header, in original order, instead of the key summary. */
  allHeaders: boolean;
  /** Truncate the body to this many characters (0 = no limit). */
  maxBody?: number;
}

function paint(text: string, code: string, color: boolean): string {
  return color ? `\x1b[${code}m${text}${"\x1b[0m"}` : text;
}

function label(name: string, color: boolean): string {
  return paint(`${name}:`.padEnd(9), "36", color); // cyan
}

/** Render the mail as text: a header summary, the body, and any attachments. */
export function renderText(mail: Mail, opts: RenderOptions): string {
  const lines: string[] = [];

  if (opts.allHeaders && mail.headers.length > 0) {
    for (const h of mail.headers) {
      lines.push(`${paint(`${h.name}:`, "36", opts.color)} ${h.value}`);
    }
  } else {
    const summary: [string, string | undefined][] = [
      ["Date", mail.date],
      ["From", mail.from],
      ["To", mail.to],
      ["Cc", mail.cc],
      ["Subject", mail.subject],
    ];
    for (const [name, value] of summary) {
      if (value && value.trim() !== "") lines.push(`${label(name, opts.color)}${value}`);
    }
  }

  lines.push("");
  const source = paint(`[${mail.format}]`, "90", opts.color);
  const bodyKind = mail.text !== undefined ? (mail.html !== undefined ? "text (html available)" : "text") : mail.html !== undefined ? "html-only" : "no body";
  lines.push(paint(`--- body: ${bodyKind} ${source} ---`, "90", opts.color));

  let body = mail.text ?? "";
  if (opts.maxBody && opts.maxBody > 0 && body.length > opts.maxBody) {
    body = `${body.slice(0, opts.maxBody)}\n... [truncated ${body.length - opts.maxBody} chars]`;
  }
  lines.push(body);

  if (mail.attachments.length > 0) {
    lines.push("");
    lines.push(paint(`--- attachments (${mail.attachments.length}) ---`, "90", opts.color));
    for (const a of mail.attachments) {
      const type = a.contentType ? ` (${a.contentType})` : "";
      lines.push(`  ${a.filename}${type}  ${a.size} bytes`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Render the mail as JSON (headers, key fields, body, attachments). */
export function renderJson(mail: Mail): string {
  return `${JSON.stringify(
    {
      format: mail.format,
      subject: mail.subject,
      from: mail.from,
      to: mail.to,
      cc: mail.cc,
      date: mail.date,
      headers: mail.headers,
      text: mail.text,
      html: mail.html,
      // Metadata only: the raw bytes belong in --save, not in JSON output.
      attachments: mail.attachments.map(({ filename, contentType, size }) => ({ filename, contentType, size })),
    },
    null,
    2,
  )}\n`;
}

export { KEY_HEADERS };
