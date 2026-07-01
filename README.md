# mailpeek

> Read `.eml` and `.msg` email files from the terminal: headers, body, HTML-to-text, or open the HTML locally. Zero-dependency CLI.

[![CI](https://github.com/printemps-tokyo/mailpeek/actions/workflows/ci.yml/badge.svg)](https://github.com/printemps-tokyo/mailpeek/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

`mailpeek` opens a saved email and shows what is inside it — the key headers
(Date, From, To, Cc, Subject), the message body, and any attachments — without a
mail client. It reads both `.eml` (MIME) and `.msg` (Outlook) files, converts
HTML messages to readable text, and can open the HTML in your browser.

```console
$ mailpeek message.eml
Date:    Wed, 1 Jul 2026 03:04:28 +0000
From:    Alice <alice@example.com>
To:      bob@example.com
Subject: Welcome aboard

--- body: text [eml] ---
Hello Bob, thanks for signing up ...
```

Everything is parsed offline with Node's built-ins, so there are no
dependencies and nothing is uploaded. The `.msg` reader includes a small
Compound File (OLE2) parser, so it does not need Outlook or any external tool.

## Requirements

- Node.js >= 20

## Install

Not published to npm yet — install from source:

```bash
git clone https://github.com/printemps-tokyo/mailpeek
cd mailpeek
npm install && npm run build
npm link   # optional: puts the `mailpeek` command on your PATH
```

Then run `mailpeek …` (after `npm link`), or `node dist/cli.js …` from the clone.

## Usage

```bash
mailpeek message.eml                 # headers + body
mailpeek invite.msg                  # Outlook .msg works the same way
mailpeek message.eml --headers       # every header, in order
mailpeek newsletter.eml --html       # print the raw HTML body
mailpeek newsletter.eml --open       # open the HTML in your browser
mailpeek message.eml --json          # machine-readable
cat message.eml | mailpeek           # ...or from stdin
```

| Option | Description |
| --- | --- |
| `<file>` | A `.eml` or `.msg` file (or piped on stdin); the format is auto-detected |
| `--headers` | Show every header, in original order, instead of the summary |
| `--html` | Print the raw HTML body (if the message has one) |
| `--open` | Write the HTML body to a temp file and open it in your default browser |
| `--no-body` | Show only the headers |
| `--max-body <n>` | Truncate the body to n characters |
| `--json` | Output JSON instead of text |
| `--no-color` | Disable ANSI colors |

## What it shows

- The key headers up front — Date, From, To, Cc, Subject — decoded from MIME
  encoded-words (RFC 2047) so non-ASCII subjects and names read correctly. Use
  `--headers` to dump the full header block in order (including the `Received`
  chain and authentication results). For `.msg` files the original internet
  headers are used when Outlook preserved them.
- The message body as text. `text/plain` is shown as-is; an HTML-only message is
  converted to readable text, and `--html` / `--open` give you the raw HTML.
- Character sets are handled for both formats (UTF-8, Shift_JIS, ISO-2022-JP,
  windows-1252, and more), including UTF-16 `.msg` property streams.
- Attachment names, media types, and sizes.

## Formats

- `.eml` — RFC 5322 / MIME: multipart trees, `quoted-printable` and `base64`
  transfer encodings, and per-part charsets.
- `.msg` — Microsoft Outlook: a Compound File Binary (OLE2) container of MAPI
  properties. mailpeek reads the subject, sender, recipients, body, attachment
  list, and the preserved transport headers directly from the property streams.

## Security

mailpeek reads your mail locally and never sends it anywhere — that is the
point. `--open` is the only action that launches another program: it writes the
HTML body to a temp file and hands it to your OS "open" command so the page
renders in your browser.

## Programmatic API

```ts
import { parseMail, renderText } from "@printemps-tokyo/mailpeek";
import { readFileSync } from "node:fs";

const mail = parseMail(new Uint8Array(readFileSync("message.eml")));
console.log(mail.subject, mail.from, mail.attachments.length);
```

`parseEml`, `parseMsg`, and the header / charset / HTML helpers are pure
functions.

## License

[MIT](./LICENSE) (c) printemps.tokyo
