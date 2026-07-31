/**
 * Appearance: how the client arranges itself, as opposed to what it blocks.
 *
 * The headline setting is the navigation layout. `classic` is Discord's own
 * arrangement: a narrow rail of server icons on the far left and a separate
 * channel/DM column beside it. `unified` follows Telegram instead. A folder
 * switcher runs along the top and one list sits below it, showing the active
 * folder only. In that list a server looks like a DM (icon, title, one line)
 * until you open it.
 *
 * The switcher is what makes this work. Stacking Direct Messages and Servers
 * in one scroll would be two lists in one container, so you would scroll more,
 * not less. One folder at a time keeps the column short and the context clear.
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
 * Folder accents come from a fixed palette, not a free colour field, so
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
 * `target` is a path within the Discord web app, never a full URL. An entry
 * therefore cannot point off-platform, and the same folder is valid whether the
 * profile is on Stable, PTB or Canary.
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
  entries: ChatEntry[];
}

/**
 * The two folders that always exist. They are not stored, so a config file
 * cannot rename or delete them, and they always lead the switcher. The first
 * two tabs stay put however the rest is arranged.
 */
export const BUILTIN_FOLDERS = [
  { id: "dms", label: "DMs", tone: "violet" },
  { id: "servers", label: "Servers", tone: "cyan" },
] as const satisfies readonly { id: string; label: string; tone: FolderTone }[];

const RESERVED_FOLDER_IDS: readonly string[] = BUILTIN_FOLDERS.map((folder) => folder.id);

export function isReservedFolderId(id: string): boolean {
  return RESERVED_FOLDER_IDS.includes(id);
}

export interface AppearanceConfig {
  layout: LayoutMode;
  /**
   * User-defined folders, shown in the switcher after the two built-ins.
   * Empty by default; nothing is invented on your behalf.
   */
  folders: ChatFolder[];
  /**
   * Which tab the unified list is showing. Remembered across restarts, because
   * a navigation UI that forgets where you were is the thing this layout exists
   * to fix.
   */
  activeFolder: string;
}

export interface FolderTab {
  readonly id: string;
  readonly label: string;
  readonly tone: FolderTone;
  readonly builtin: boolean;
  readonly count: number;
}

/**
 * The switcher's contents: the two built-ins followed by the user's folders.
 * Derived, not stored, so the tab strip can never disagree with the
 * folder list it came from.
 */
export function folderTabs(config: AppearanceConfig): FolderTab[] {
  return [
    ...BUILTIN_FOLDERS.map((folder) => ({
      id: folder.id,
      label: folder.label,
      tone: folder.tone as FolderTone,
      builtin: true,
      // Built-in groups are populated by Discord itself, not by us, so there
      // is no count to show.
      count: -1,
    })),
    ...config.folders.map((folder) => ({
      id: folder.id,
      label: folder.name,
      tone: folder.tone,
      builtin: false,
      count: folder.entries.length,
    })),
  ];
}

export const MAX_FOLDERS = 12;
export const MAX_ENTRIES_PER_FOLDER = 100;

export function defaultAppearance(): AppearanceConfig {
  return { layout: "unified", folders: [], activeFolder: "dms" };
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

/**
 * A user folder may not claim a built-in id, or the switcher would show two
 * tabs that resolve to the same thing.
 */
function cleanFolderId(value: unknown, fallback: string): string {
  const id = cleanId(value, fallback);
  return isReservedFolderId(id) ? `${id}-1` : id;
}

function cleanName(value: unknown, fallback: string, max: number): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().slice(0, max);
  return trimmed || fallback;
}

/**
 * Re-validates appearance config from disk or from the renderer. Entries whose
 * target does not survive normalization are dropped instead of kept in a
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

    const id = cleanFolderId(folder["id"], `folder${folders.length + 1}`);
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
      entries,
    });
  }

  // The remembered tab may be gone: folder deleted, or config copied from
  // another machine. Fall back to the first built-in so the switcher always
  // points at something.
  const requested = raw["activeFolder"];
  const known = new Set<string>([...RESERVED_FOLDER_IDS, ...folders.map((folder) => folder.id)]);
  const activeFolder = typeof requested === "string" && known.has(requested) ? requested : "dms";

  return { layout, folders, activeFolder };
}
