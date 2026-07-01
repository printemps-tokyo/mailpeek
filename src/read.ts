/** File / stdin input and format detection for mailpeek. */
import { readFile } from "node:fs/promises";
import { isCfb } from "./cfb.js";
import { parseEml } from "./mime.js";
import { parseMsg } from "./msg.js";
import type { Mail } from "./mail.js";

async function readStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

/** Decide eml vs msg from the bytes (and a filename hint), then parse. */
export function parseMail(bytes: Uint8Array, filename?: string): Mail {
  if (isCfb(bytes)) return parseMsg(bytes);
  if (filename && /\.msg$/i.test(filename) && isCfb(bytes)) return parseMsg(bytes);
  return parseEml(bytes);
}

/** Read a mail from a file path, or from stdin when no path is given. */
export async function readMail(path?: string): Promise<Mail> {
  const bytes = path ? new Uint8Array(await readFile(path)) : await readStdin();
  return parseMail(bytes, path);
}
