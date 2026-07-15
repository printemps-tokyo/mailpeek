/** Write parsed attachments to a directory (the --save flag). */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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

/**
 * Make an attachment filename safe to write inside a directory:
 * - control characters (CR, LF, NUL, ...) are removed,
 * - path separators, and percent-encoded ones (%2F, %5C), become "_" so the
 *   name can never traverse out of the target directory,
 * - names that reduce to "", "." or ".." return "" (caller picks a fallback).
 */
export function sanitizeFilename(name: string): string {
  let s = "";
  for (const ch of name) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) continue;
    s += ch === "/" || ch === "\\" ? "_" : ch;
  }
  s = s.replace(/%2f|%5c/gi, "_").trim();
  if (s === "" || s === "." || s === "..") return "";
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
    if (!opts.force && existsSync(target)) {
      throw new Error(`refusing to overwrite ${target} (use --force)`);
    }
    const content = a.content ?? new Uint8Array(0);
    await writeFile(target, content);
    written.push({ path: target, size: content.length });
  }
  return written;
}
