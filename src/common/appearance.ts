/**
 * Appearance: how the client arranges itself, as opposed to what it blocks.
 *
 * The headline setting is the navigation layout. `classic` is Discord's own
 * arrangement — a narrow rail of server icons on the far left, a separate
 * channel/DM column beside it. `unified` is a single merged column in the
 * Telegram idiom: one scrollable list, grouped into folders, where a server
 * reads exactly like a DM (icon, title, one line) until you open it.
 *
 * The naming is deliberate. "Modern" ages badly and says nothing; "legacy"
 * implies the other option is deprecated when it is a perfectly good layout
 * many people prefer. `unified` describes what it actually does, and `classic`
 * is the neutral word for the original.
 */

export type LayoutMode = "unified" | "classic";

export const LAYOUT_MODES: readonly LayoutMode[] = ["unified", "classic"];

export function isLayoutMode(value: unknown): value is LayoutMode {
  return value === "unified" || value === "classic";
}

/**
 * Folder accents come from a fixed palette rather than a free colour field, so
 * the value maps to a stylesheet class. The panel forbids inline styles, and a
 * closed set keeps the UI coherent instead of letting it become a paintbox.
 */
export const FOLDER_TONES = ["violet", "green", "amber", "rose", "cyan", "slate"] as const;

export type FolderTone = (typeof FOLDER_TONES)[number];

export function isFolderTone(value: unknown): value is FolderTone {
  return typeof value === "string" && (FOLDER_TONES as readonly string[]).includes(value);
}

/**
 * One entry in a folder: a chat you want reachable from the merged list.
 *
 * `target` is a path within the Discord web app, never a full URL, so an entry
 * can never point off-platform and works across all three release channels —
 * the same folder is valid whether the profile is on Stable or Canary.
 */
export interface ChatEntry {
  readonly id: string;
  /** What the row shows. Yours to choose; Discord's own name is not readable from here. */
  name: string;
  /** e.g. `/channels/@me/123` or `/channels/456/789`. */
  target: string;
}

export interface ChatFolder {
  readonly id: string;
  name: string;
  tone: FolderTone;
  /** Collapsed state is remembered, which is the point of the layout. */
  collapsed: boolean;
  entries: ChatEntry[];
}

export interface AppearanceConfig {
  layout: LayoutMode;
  /**
   * User-defined folders, shown after the two built-in groups. Empty by
   * default — nothing is invented on your behalf.
   */
  folders: ChatFolder[];
}

export const MAX_FOLDERS = 12;
export const MAX_ENTRIES_PER_FOLDER = 100;

export function defaultAppearance(): AppearanceConfig {
  return { layout: "unified", folders: [] };
}

/**
 * Accepts either a full Discord URL or a bare path, and returns a normalized
 * channel path. Anything that is not a Discord channel path is rejected, which
 * is what stops a folder entry from becoming a link to an arbitrary site.
 */
export function normalizeChatTarget(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  let path = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      // Only Discord's own channel URLs; the release channel is irrelevant
      // because the path is what we keep.
      if (!/^(?:[a-z]+\.)?discord\.com$/i.test(url.hostname)) return null;
      path = url.pathname;
    } catch {
      return null;
    }
  }

  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/+$/, "");

  // `/channels/@me/<id>` for a DM, `/channels/<guild>[/<channel>]` for a server.
  if (!/^\/channels\/(?:@me\/\d+|\d+(?:\/\d+)?)$/.test(path)) return null;
  return path;
}

export function isDirectMessageTarget(target: string): boolean {
  return target.startsWith("/channels/@me/");
}

function cleanId(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(value) ? value : fallback;
}

function cleanName(value: unknown, fallback: string, max: number): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().slice(0, max);
  return trimmed || fallback;
}

/**
 * Re-validates appearance config from disk or from the renderer. Entries whose
 * target does not survive normalization are dropped rather than kept in a
 * broken state, and ids are de-duplicated so a hand-edited file cannot produce
 * two folders that the UI cannot tell apart.
 */
export function normalizeAppearance(input: unknown): AppearanceConfig {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const layout = isLayoutMode(raw["layout"]) ? raw["layout"] : "unified";

  const seenFolders = new Set<string>();
  const folders: ChatFolder[] = [];

  const rawFolders = Array.isArray(raw["folders"]) ? (raw["folders"] as unknown[]) : [];
  for (const candidate of rawFolders) {
    if (folders.length >= MAX_FOLDERS) break;
    if (typeof candidate !== "object" || candidate === null) continue;
    const folder = candidate as Record<string, unknown>;

    const id = cleanId(folder["id"], `folder${folders.length + 1}`);
    if (seenFolders.has(id)) continue;
    seenFolders.add(id);

    const seenEntries = new Set<string>();
    const entries: ChatEntry[] = [];
    const rawEntries = Array.isArray(folder["entries"]) ? (folder["entries"] as unknown[]) : [];

    for (const entryCandidate of rawEntries) {
      if (entries.length >= MAX_ENTRIES_PER_FOLDER) break;
      if (typeof entryCandidate !== "object" || entryCandidate === null) continue;
      const entry = entryCandidate as Record<string, unknown>;

      const target = normalizeChatTarget(entry["target"]);
      if (!target) continue;

      const entryId = cleanId(entry["id"], `entry${entries.length + 1}`);
      if (seenEntries.has(entryId)) continue;
      seenEntries.add(entryId);

      entries.push({ id: entryId, name: cleanName(entry["name"], "Chat", 48), target });
    }

    folders.push({
      id,
      name: cleanName(folder["name"], "Folder", 32),
      tone: isFolderTone(folder["tone"]) ? folder["tone"] : "violet",
      collapsed: folder["collapsed"] === true,
      entries,
    });
  }

  return { layout, folders };
}
