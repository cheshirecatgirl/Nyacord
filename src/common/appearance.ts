/**
 * Appearance: how the client arranges itself, as opposed to what it blocks.
 *
 * The one setting is the navigation layout. `classic` is Discord's own
 * arrangement: a narrow rail of server icons on the far left and a separate
 * channel/DM column beside it. `unified` follows Telegram instead. A small
 * switcher runs along the top of the sidebar and one list sits below it,
 * showing either your DMs or your servers.
 *
 * The switcher is what makes this work. Stacking both in one scroll would be
 * two lists in one container, so you would scroll more, not less. One at a
 * time keeps the column short and the context clear.
 *
 * There is no folder model here. Discord already has server folders, with drag
 * and drop, saved to your account and synced everywhere. Building a second
 * folder system beside it would be a hand-curated copy of something that
 * already works, so the Servers tab shows Discord's own list and its folders
 * come with it.
 */

export type LayoutMode = "unified" | "classic";

export const LAYOUT_MODES: readonly LayoutMode[] = ["unified", "classic"];

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
 * Where the Discord view currently is, worked out from its URL.
 *
 * This is the whole reason the switcher needs nothing from inside the page.
 * Discord's routes are URLs, so `webContents.getURL()` already says whether
 * you are in direct messages or in a server, and which server.
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
