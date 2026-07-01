/** Open an HTML body in the local default browser (via a temp file). */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The platform command that opens a file/URL in the default application. */
function opener(): { cmd: string; args: string[] } {
  switch (process.platform) {
    case "darwin":
      return { cmd: "open", args: [] };
    case "win32":
      return { cmd: "cmd", args: ["/c", "start", ""] };
    default:
      return { cmd: "xdg-open", args: [] };
  }
}

/**
 * Write HTML to a temp file and open it in the default browser. Returns the
 * path written. A minimal UTF-8 wrapper is added when the fragment lacks one so
 * the page renders with the right encoding.
 */
export async function openHtmlInBrowser(html: string, timestamp: number): Promise<string> {
  const doc = /<html[\s>]/i.test(html)
    ? html
    : `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
  const path = join(tmpdir(), `mailpeek-${timestamp}.html`);
  await writeFile(path, doc, "utf8");

  const { cmd, args } = opener();
  const child = spawn(cmd, [...args, path], { stdio: "ignore", detached: true });
  child.unref();
  return path;
}
