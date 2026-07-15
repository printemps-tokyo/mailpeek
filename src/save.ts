/** Write parsed attachments to a directory (the --save flag). */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Attachment } from "./mail.js";

/** Placeholder used by the parsers when an attachment has no recoverable name. */
const UNNAMED = "(unnamed)";

/** Fallback extensions for common media types (anything else gets .bin). */
const EXT_BY_TYPE: Record<string, string> = {
  "text/plain": ".txt",
  "text/html": ".html",
  "text/csv": ".csv",
  "text/calendar": ".ics",
  "application/pdf": ".pdf",
  "application/json": ".json",
  "application/zip": ".zip",
  "application/xml": ".xml",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
};

/** Guess a file extension from a media type; ".bin" when unknown. */
export function extensionForContentType(contentType?: string): string {
  if (!contentType) return ".bin";
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return EXT_BY_TYPE[type] ?? ".bin";
}

/** Windows-reserved device basenames; reserved with or without an extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Keep filenames comfortably under common 255-byte filesystem limits. */
const MAX_NAME_BYTES = 200;

/** An "extension" longer than this is treated as part of the base name. */
const MAX_EXT_BYTES = 32;

function utf8Length(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Cut a string so its UTF-8 form fits in maxBytes, never splitting a code point. */
function truncateUtf8(s: string, maxBytes: number): string {
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    bytes += Buffer.byteLength(ch, "utf8");
    if (bytes > maxBytes) break;
    out += ch;
  }
  return out;
}

/**
 * Make an attachment filename safe to write inside a directory:
 * - control characters (CR, LF, NUL, ...) are removed,
 * - path separators, percent-encoded ones (%2F, %5C), and characters Windows
 *   forbids (< > : " | ? *) become "_", so the name can never traverse out of
 *   the target directory,
 * - trailing dots and spaces are trimmed (Windows drops them on create),
 * - names longer than 200 UTF-8 bytes are truncated, keeping the extension,
 *   so a hostile name cannot abort the run with ENAMETOOLONG,
 * - Windows-reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9 — with
 *   or without an extension, any case) get a "_" prefix,
 * - names that reduce to "", "." or ".." return "" (caller picks a fallback).
 */
export function sanitizeFilename(name: string): string {
  let s = "";
  for (const ch of name) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) continue;
    s += '/\\<>:"|?*'.includes(ch) ? "_" : ch;
  }
  s = s
    .replace(/%2f|%5c/gi, "_")
    .trim()
    .replace(/[. ]+$/, "");
  if (s === "" || s === "." || s === "..") return "";

  if (utf8Length(s) > MAX_NAME_BYTES) {
    let [base, ext] = splitExt(s);
    if (utf8Length(ext) > MAX_EXT_BYTES) {
      base = s;
      ext = "";
    }
    s = truncateUtf8(base, MAX_NAME_BYTES - utf8Length(ext)) + ext;
  }

  if (WINDOWS_RESERVED.test(s.split(".", 1)[0]!)) s = `_${s}`;
  return s;
}

/** Split "report.pdf" into ["report", ".pdf"]; dotfiles keep the whole name as base. */
function splitExt(name: string): [base: string, ext: string] {
  const i = name.lastIndexOf(".");
  if (i <= 0) return [name, ""];
  return [name.slice(0, i), name.slice(i)];
}

export interface SaveOptions {
  /** 1-based index (as shown in the attachment listing) to save just one. */
  only?: number;
  /** Overwrite files that already exist in the directory. */
  force?: boolean;
}

export interface SavedFile {
  path: string;
  size: number;
}

/**
 * Write attachments into `dir` (created if missing) and return the paths.
 *
 * Filenames are sanitized; unnamed attachments become "attachment" with an
 * extension guessed from the media type. When two attachments in the same
 * message resolve to the same name, later ones get a -1, -2, ... suffix.
 * A file that already exists on disk is never overwritten unless `force`.
 */
export async function saveAttachments(
  attachments: Attachment[],
  dir: string,
  opts: SaveOptions = {},
): Promise<SavedFile[]> {
  let selected = attachments;
  if (opts.only !== undefined) {
    if (!Number.isInteger(opts.only) || opts.only < 1 || opts.only > attachments.length) {
      const n = attachments.length;
      throw new Error(`--only ${opts.only} is out of range (message has ${n} attachment${n === 1 ? "" : "s"})`);
    }
    selected = [attachments[opts.only - 1]!];
  }

  await mkdir(dir, { recursive: true });

  const taken = new Set<string>();
  const written: SavedFile[] = [];
  for (const a of selected) {
    let name = sanitizeFilename(a.filename === UNNAMED ? "" : a.filename);
    if (name === "") name = `attachment${extensionForContentType(a.contentType)}`;

    const [base, ext] = splitExt(name);
    let candidate = name;
    for (let i = 1; taken.has(candidate.toLowerCase()); i++) candidate = `${base}-${i}${ext}`;
    taken.add(candidate.toLowerCase());

    const target = join(dir, candidate);
    const content = a.content ?? new Uint8Array(0);
    if (opts.force) {
      // Remove whatever occupies the name first (a plain file, or a symlink —
      // removed as the link itself, not its target) so the exclusive create
      // below writes a fresh regular file instead of following a symlink.
      await rm(target, { force: true });
    }
    try {
      // "wx" (O_CREAT | O_EXCL) makes the no-overwrite check atomic: it cannot
      // race with a concurrent create, and it refuses to follow a pre-planted
      // symlink (even a dangling one, which existsSync would report as absent).
      await writeFile(target, content, { flag: "wx" });
    } catch (err) {
      if (!opts.force && (err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`refusing to overwrite ${target} (use --force)`);
      }
      throw err;
    }
    written.push({ path: target, size: content.length });
  }
  return written;
}
