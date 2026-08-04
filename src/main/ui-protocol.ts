import { protocol, type Session } from "electron";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

/**
 * Our own UI is served over a private scheme instead of `file:`.
 *
 * The reason is a fuse. `GrantFileProtocolExtraPrivileges` is off, which is
 * what we want: it strips `file:` pages of the powers Electron hands them
 * beyond a normal browser. Asar path resolution turns out to be one of those
 * powers, so in a packaged build a `file://…/app.asar/…/shell.html` simply
 * fails with ERR_FILE_NOT_FOUND. Unpackaged it works, which is exactly the
 * shape of bug that ships.
 *
 * Turning the fuse back on would fix it and cost the hardening. Serving the UI
 * from `nya://ui` fixes it and improves on the original: the panel, the strip
 * and the lock screen get a real origin of their own, `'self'` in their CSP
 * means something specific, and `file:` stays de-privileged.
 */
export const UI_SCHEME = "nya";
export const UI_ORIGIN = `${UI_SCHEME}://ui`;

/**
 * The partition all three UI views share: in-memory, no cookies, never used for
 * anything remote. Named once here because the scheme is served on it, so the
 * handler and the views have to agree.
 */
export const SHELL_PARTITION = "nya-shell";

/** Everything servable, named in full. An allowlist has no traversal to reason about. */
const FILES = new Set([
  "shell.html",
  "shell.css",
  "shell.js",
  "switcher.html",
  "switcher.css",
  "switcher.js",
  "lock.html",
  "lock.css",
  "lock.js",
]);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

/**
 * Must run before `app.whenReady()`. `standard` gives the scheme a real origin,
 * so `'self'` resolves and the pages are not opaque; `secure` keeps them out of
 * the mixed-content and insecure-origin buckets.
 */
export function registerUiScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: UI_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        corsEnabled: false,
        allowServiceWorkers: false,
        stream: false,
      },
    },
  ]);
}

/** Serves the UI on one session. `root` is `dist/src/renderer`, inside the asar. */
export function serveUi(session: Session, root: string): void {
  session.protocol.handle(UI_SCHEME, async (request) => {
    const url = new URL(request.url);
    const name = decodeURIComponent(url.pathname).replace(/^\//, "");

    if (url.hostname !== "ui" || !FILES.has(name)) {
      return new Response("not found", { status: 404 });
    }

    try {
      const body = await readFile(join(root, name));
      return new Response(body, {
        headers: { "content-type": MIME[extname(name)] ?? "application/octet-stream" },
      });
    } catch (error) {
      console.error(`[nya] could not serve ${name}:`, error);
      return new Response("unreadable", { status: 500 });
    }
  });
}
