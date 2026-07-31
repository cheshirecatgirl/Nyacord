import type { WebContents } from "electron";

import { isNavigableHost, type ChannelDef } from "../../common/channels";
import { openExternalSafely } from "./session";

/**
 * Navigation containment.
 *
 * The Discord view is allowed to be Discord and nothing else. Any attempt to
 * navigate the top-level frame somewhere else (a phishing link, a redirect
 * chain, an OAuth hop to a host we do not control) is cancelled and handed to
 * the user's real browser, where their usual defences apply.
 *
 * This matters more in a desktop shell than in a browser: there is no address
 * bar here, so a page that navigates itself away is a page the user cannot
 * see the destination of.
 */
export function containNavigation(contents: WebContents, channel: ChannelDef): void {
  contents.on("will-navigate", (event, url) => {
    if (allowed(url, channel)) return;
    event.preventDefault();
    openExternalSafely(url);
  });

  // Covers `window.location` changes performed by the renderer that do not
  // produce a `will-navigate` (same-document redirects into a new origin).
  contents.on("will-redirect", (event, url) => {
    if (allowed(url, channel)) return;
    event.preventDefault();
    openExternalSafely(url);
  });

  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: "deny" };
  });

  // A renderer must never be able to talk us into attaching Node or a preload
  // to a child frame.
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  // Belt and braces: if something does manage to create a child window, strip
  // its privileges before it loads.
  contents.on("did-attach-webview", (_event, webContents) => {
    webContents.close();
  });
}

function allowed(url: string, channel: ChannelDef): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return isNavigableHost(parsed.hostname, channel);
  } catch {
    return false;
  }
}

/**
 * Applied to our own internal UI, which is loaded from `file:` and must never
 * navigate anywhere at all.
 */
export function freezeNavigation(contents: WebContents): void {
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: "deny" };
  });
}
