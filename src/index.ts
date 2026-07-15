/**
 * Public API for mailpeek.
 *
 * mailpeek reads .eml (MIME) and .msg (Outlook / CFB) email files entirely
 * offline and normalizes them into a single `Mail` model: ordered headers, the
 * key address fields, a plain-text body (derived from HTML when needed), the
 * HTML body, and attachment metadata. Parsing is pure; only reading files and
 * opening the browser touch the outside world.
 */

export type { Mail, Header, Attachment } from "./mail.js";
export { headerValue, headerValues } from "./mail.js";

export { parseEml } from "./mime.js";
export { parseMsg, looksLikeMsg } from "./msg.js";
export { isCfb, parseCfb } from "./cfb.js";
export { parseMail } from "./read.js";

export { parseHeaderBlock, splitHeaderBody } from "./headers.js";
export { decodeEncodedWords } from "./encoded-word.js";
export { decodeQuotedPrintable, decodeBase64 } from "./quoted-printable.js";
export { decodeBytes, decodeUtf16Le, normalizeCharset } from "./charset.js";
export { htmlToText, decodeEntities } from "./html-to-text.js";
export { renderText, renderJson } from "./render.js";
export { saveAttachments, sanitizeFilename, extensionForContentType } from "./save.js";
export type { SaveOptions, SavedFile } from "./save.js";
