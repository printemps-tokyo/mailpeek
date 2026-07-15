#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readMail } from "./read.js";
import { renderJson, renderText } from "./render.js";
import { openHtmlInBrowser } from "./open.js";
import { saveAttachments } from "./save.js";

const HELP = `mailpeek - read .eml and .msg email files from the terminal

Usage:
  mailpeek [options] <file>       Read a .eml or .msg file (or pipe it on stdin)

Shows the key headers (Date, From, To, Cc, Subject) and the message body. HTML
messages are converted to text, or opened in your browser with --open. The
format is detected from the content, so both .eml (MIME) and .msg (Outlook)
work. Everything is parsed offline; only --open launches an external program.

Options:
  --headers           Show every header, in order, instead of the summary
  --html              Print the raw HTML body (if the message has one)
  --open              Open the HTML body in your default browser
  --no-body           Show only headers, not the body
  --max-body <n>      Truncate the body to n characters
  --save <dir>        Write all attachments into <dir> (created if missing)
  --only <n>          With --save: write only attachment n (1-based, as listed)
  --force             With --save: overwrite files that already exist
  --json              Output JSON instead of text
  --no-color          Disable ANSI colors
  -h, --help          Show this help
  -v, --version       Show version

Examples:
  mailpeek message.eml
  mailpeek "invite.msg" --headers
  mailpeek newsletter.eml --open
  mailpeek report.msg --save ./attachments
  mailpeek message.eml --save out --only 2
  cat message.eml | mailpeek --json
`;

async function readVersion(): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    const raw = await readFile(join(here, "..", "package.json"), "utf8");
    return (JSON.parse(raw) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.includes("-v") || argv.includes("--version")) {
    process.stdout.write((await readVersion()) + "\n");
    return 0;
  }

  let values;
  let positionals;
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        headers: { type: "boolean", default: false },
        html: { type: "boolean", default: false },
        open: { type: "boolean", default: false },
        "no-body": { type: "boolean", default: false },
        "max-body": { type: "string" },
        save: { type: "string" },
        only: { type: "string" },
        force: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        "no-color": { type: "boolean", default: false },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.stderr.write("run 'mailpeek --help' for usage.\n");
    return 1;
  }

  const path = positionals[0];
  if (path === undefined && process.stdin.isTTY) {
    process.stderr.write("error: give a .eml/.msg file, or pipe one on stdin\n\n" + HELP);
    return 1;
  }

  if (values.only !== undefined && values.save === undefined) {
    process.stderr.write("error: --only requires --save <dir>\n");
    return 1;
  }

  let mail;
  try {
    mail = await readMail(path);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  if (values.save !== undefined) {
    if (mail.attachments.length === 0) {
      process.stderr.write("error: this message has no attachments\n");
      return 1;
    }
    let only: number | undefined;
    if (values.only !== undefined) {
      only = Number(values.only);
      if (!Number.isInteger(only) || only < 1) {
        process.stderr.write("error: --only expects a positive attachment number (as listed)\n");
        return 1;
      }
    }
    try {
      const written = await saveAttachments(mail.attachments, values.save, { only, force: values.force });
      for (const f of written) process.stdout.write(`saved ${f.path} (${f.size} bytes)\n`);
    } catch (err) {
      process.stderr.write(`error: ${(err as Error).message}\n`);
      return 1;
    }
    return 0;
  }

  if (values.open) {
    if (mail.html === undefined) {
      process.stderr.write("error: this message has no HTML body to open\n");
      return 1;
    }
    const file = await openHtmlInBrowser(mail.html, Date.now());
    process.stderr.write(`opened ${file} in your browser\n`);
    return 0;
  }

  if (values.html) {
    if (mail.html === undefined) {
      process.stderr.write("error: this message has no HTML body\n");
      return 1;
    }
    process.stdout.write(mail.html.endsWith("\n") ? mail.html : mail.html + "\n");
    return 0;
  }

  if (values.json) {
    process.stdout.write(renderJson(mail));
    return 0;
  }

  const color = !values["no-color"] && !process.env.NO_COLOR && process.stdout.isTTY === true;
  const bodyMail = values["no-body"] ? { ...mail, text: "", html: undefined } : mail;
  const maxBody = values["max-body"] ? Number(values["max-body"]) : undefined;
  process.stdout.write(renderText(bodyMail, { color, allHeaders: values.headers, maxBody }));
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exitCode = 1;
  });
