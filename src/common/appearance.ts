/**
 * How the client arranges itself, as opposed to what it blocks.
 *
 * One setting: the navigation layout. `classic` is Discord's own arrangement,
 * a narrow rail of server icons beside a separate channel column. `unified`
 * follows Telegram: a switcher along the top of the sidebar with one list
 * below it, showing either DMs or servers.
 *
 * The switcher is what makes it work. Stacking both lists in one scroll would
 * mean scrolling more, not less; one at a time keeps the column short.
 *
 * No folder model of our own. Discord's server folders already exist, with
 * drag and drop, synced to the account, so the Servers tab shows Discord's
 * list and the folders come with it.
 */

export type LayoutMode = "unified" | "classic";

export function isLayoutMode(value: unknown): value is LayoutMode {
  return value === "unified" || value === "classic";
}

export type SidebarTabId = "dms" | "servers";

export const SIDEBAR_TABS = [
  { id: "dms", label: "DMs" },
  { id: "servers", label: "Servers" },
] as const satisfies readonly { id: SidebarTabId; label: string }[];

export function isSidebarTab(value: unknown): value is SidebarTabId {
  return value === "dms" || value === "servers";
}

/**
 * The strip's size, in device-independent pixels. Also decides how much room
 * the stylesheet reserves and how far the server rail widens, so the numbers
 * are handed over as custom properties instead of written down twice. A 40px
 * strip over a 32px gap is a visible seam.
 */
export const SWITCHER_HEIGHT = 40;
export const SWITCHER_WIDTH = 240;

export interface AppearanceConfig {
  layout: LayoutMode;
  /**
   * Which side of the switcher is showing. Remembered across restarts, because
   * a navigation UI that forgets where you were is what this layout exists to
   * fix.
   */
  activeTab: SidebarTabId;
}

export function defaultAppearance(): AppearanceConfig {
  return { layout: "unified", activeTab: "dms" };
}

export function normalizeAppearance(input: unknown): AppearanceConfig {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  return {
    layout: isLayoutMode(raw["layout"]) ? raw["layout"] : "unified",
    activeTab: isSidebarTab(raw["activeTab"]) ? raw["activeTab"] : "dms",
  };
}

/**
 * Where the Discord view is, worked out from its URL. Discord's routes are
 * URLs, so `webContents.getURL()` already says whether you are in direct
 * messages or in a server, and which one. This is why the switcher needs
 * nothing from inside the page.
 */
export type ChatContext =
  | { readonly kind: "dms" }
  | { readonly kind: "server"; readonly guildId: string }
  | { readonly kind: "other" };

const DM_PATH = /^\/channels\/@me(?:\/|$)/;
const GUILD_PATH = /^\/channels\/(\d+)(?:\/|$)/;

export function contextFromPath(pathname: string): ChatContext {
  if (DM_PATH.test(pathname)) return { kind: "dms" };
  const guild = GUILD_PATH.exec(pathname);
  return guild?.[1] ? { kind: "server", guildId: guild[1] } : { kind: "other" };
}

export function contextFromUrl(url: string): ChatContext {
  try {
    return contextFromPath(new URL(url).pathname);
  } catch {
    return { kind: "other" };
  }
}

/** The tab a context implies, so the switcher can follow navigation. */
export function tabForContext(context: ChatContext): SidebarTabId | null {
  if (context.kind === "dms") return "dms";
  if (context.kind === "server") return "servers";
  return null;
}
