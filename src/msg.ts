/**
 * Parse an Outlook .msg file (a CFB container of MAPI properties, [MS-OXMSG])
 * into the normalized Mail model. Zero-dependency: strings come straight from
 * the __substg1.0_* streams and the raw internet headers when present.
 */
import { decodeBytes, decodeUtf16Le } from "./charset.js";
import { isCfb, parseCfb } from "./cfb.js";
import { parseHeaderBlock } from "./headers.js";
import { htmlToText } from "./html-to-text.js";
import { headerValue, type Attachment, type Header, type Mail } from "./mail.js";

/** Re-export so callers can sniff a buffer before choosing a parser. */
export { isCfb } from "./cfb.js";

// Property IDs of interest (see [MS-OXPROPS]).
const P = {
  SUBJECT: "0037",
  BODY: "1000",
  HTML: "1013",
  HEADERS: "007D",
  SENDER_NAME: "0C1A",
  SENDER_EMAIL: "0C1F",
  SENDER_SMTP: "5D01",
  DISPLAY_TO: "0E04",
  DISPLAY_CC: "0E03",
  SUBMIT_TIME: "0039",
  DELIVERY_TIME: "0E06",
  INTERNET_CPID: "3FDE",
  ATTACH_LONG_FILENAME: "3707",
  ATTACH_FILENAME: "3704",
  ATTACH_MIME_TAG: "370E",
  ATTACH_SIZE: "0E20",
} as const;

const TOP_SUBSTG = /^__substg1\.0_([0-9A-Fa-f]{4})([0-9A-Fa-f]{4})$/;
const CHILD_SUBSTG = /(?:^|\/)__substg1\.0_([0-9A-Fa-f]{4})([0-9A-Fa-f]{4})$/;

interface Prop {
  type: string;
  bytes: Uint8Array;
}

/** Decode a string-typed property (Unicode 001F, or 8-bit 001E) to text. */
function decodeStringProp(p: Prop | undefined, charset: string): string | undefined {
  if (!p) return undefined;
  if (p.type.toLowerCase() === "001f") return decodeUtf16Le(p.bytes);
  return decodeBytes(p.bytes, charset);
}

/** Windows code page id -> a charset label TextDecoder understands. */
function codePageToCharset(cpid: number | undefined): string {
  switch (cpid) {
    case 65001:
      return "utf-8";
    case 932:
      return "shift_jis";
    case 936:
      return "gbk";
    case 949:
      return "euc-kr";
    case 950:
      return "big5";
    case 20932:
      return "euc-jp";
    case 50220:
    case 50221:
    case 50222:
      return "iso-2022-jp";
    case 1252:
      return "windows-1252";
    default:
      return "utf-8";
  }
}

/** Parse the fixed-width __properties_version1.0 stream (top-level, 32-byte head). */
function parseFixedProps(bytes: Uint8Array | undefined): Map<string, DataView> {
  const map = new Map<string, DataView>();
  if (!bytes || bytes.length < 32) return map;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let o = 32; o + 16 <= bytes.length; o += 16) {
    const type = dv.getUint16(o, true);
    const id = dv.getUint16(o + 2, true);
    const idHex = id.toString(16).padStart(4, "0").toUpperCase();
    const typeHex = type.toString(16).padStart(4, "0");
    map.set(`${idHex}${typeHex}`, new DataView(bytes.buffer, bytes.byteOffset + o + 8, 8));
  }
  return map;
}

/** Convert a Windows FILETIME (100ns since 1601) to an ISO date string. */
function fileTimeToIso(low: number, high: number): string | undefined {
  const intervals = high * 4294967296 + low; // 2^32
  if (intervals <= 0) return undefined;
  const ms = intervals / 10000 - 11644473600000;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toUTCString() : undefined;
}

function joinNameEmail(name?: string, email?: string): string | undefined {
  const n = name?.trim();
  const e = email?.trim();
  if (n && e && n !== e) return `${n} <${e}>`;
  return e || n || undefined;
}

/** Parse .msg bytes into a Mail. */
export function parseMsg(input: Uint8Array): Mail {
  const streams = parseCfb(input);

  // Index top-level string/binary properties by id.
  const top = new Map<string, Prop>();
  const attachStreams = new Map<string, Map<string, Prop>>();
  for (const [path, bytes] of streams) {
    if (!path.includes("/")) {
      const m = TOP_SUBSTG.exec(path);
      if (m) top.set(m[1]!.toUpperCase(), { type: m[2]!, bytes });
      continue;
    }
    // Attachment sub-storage streams: group by the __attach_* container.
    const attachMatch = /^(__attach_version1\.0_#[0-9A-Fa-f]+)\//.exec(path);
    const sm = CHILD_SUBSTG.exec(path);
    if (attachMatch && sm) {
      const key = attachMatch[1]!;
      if (!attachStreams.has(key)) attachStreams.set(key, new Map());
      attachStreams.get(key)!.set(sm[1]!.toUpperCase(), { type: sm[2]!, bytes });
    }
  }

  const fixed = parseFixedProps(streams.get("__properties_version1.0"));
  const cpidView = fixed.get(`${P.INTERNET_CPID}0003`);
  const cpid = cpidView ? cpidView.getUint32(0, true) : undefined;
  const charset = codePageToCharset(cpid);

  const subject = decodeStringProp(top.get(P.SUBJECT), charset);
  const bodyText = decodeStringProp(top.get(P.BODY), charset);
  const senderName = decodeStringProp(top.get(P.SENDER_NAME), charset);
  const senderSmtp = decodeStringProp(top.get(P.SENDER_SMTP), charset);
  const senderEmail = decodeStringProp(top.get(P.SENDER_EMAIL), charset);
  const displayTo = decodeStringProp(top.get(P.DISPLAY_TO), charset);
  const displayCc = decodeStringProp(top.get(P.DISPLAY_CC), charset);
  const transportHeaders = decodeStringProp(top.get(P.HEADERS), charset);

  const htmlProp = top.get(P.HTML);
  const html = htmlProp ? decodeBytes(htmlProp.bytes, charset) : undefined;

  // Prefer the real internet headers when Outlook preserved them.
  let headers: Header[] = transportHeaders ? parseHeaderBlock(transportHeaders) : [];

  const from = joinNameEmail(senderName, senderSmtp || senderEmail) ?? headerValue(headers, "from");
  const to = displayTo ?? headerValue(headers, "to");
  const cc = displayCc ?? headerValue(headers, "cc");

  let date = headerValue(headers, "date");
  if (!date) {
    const t = fixed.get(`${P.SUBMIT_TIME}0040`) ?? fixed.get(`${P.DELIVERY_TIME}0040`);
    if (t) date = fileTimeToIso(t.getUint32(0, true), t.getUint32(4, true));
  }

  // Synthesize a minimal header list if none were preserved, so --headers works.
  if (headers.length === 0) {
    headers = [
      ["From", from],
      ["To", to],
      ["Cc", cc],
      ["Subject", subject],
      ["Date", date],
    ]
      .filter((h): h is [string, string] => typeof h[1] === "string" && h[1] !== "")
      .map(([name, value]) => ({ name, value }));
  }

  const attachments: Attachment[] = [];
  for (const props of attachStreams.values()) {
    const filename =
      decodeStringProp(props.get(P.ATTACH_LONG_FILENAME), charset) ??
      decodeStringProp(props.get(P.ATTACH_FILENAME), charset);
    const data = props.get("3701"); // PR_ATTACH_DATA_BIN
    attachments.push({
      // An attachment record must never vanish just because it has no name.
      filename: filename || "(unnamed)",
      contentType: decodeStringProp(props.get(P.ATTACH_MIME_TAG), charset),
      size: data ? data.bytes.length : 0,
    });
  }

  return {
    format: "msg",
    headers,
    subject,
    from,
    to,
    cc,
    date,
    text: bodyText && bodyText.trim() !== "" ? bodyText : html ? htmlToText(html) : bodyText,
    html,
    attachments,
  };
}

/** True if the buffer looks like an Outlook .msg (a compound file). */
export function looksLikeMsg(bytes: Uint8Array): boolean {
  return isCfb(bytes);
}
