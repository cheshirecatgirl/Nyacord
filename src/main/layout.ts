import { existsSync, mkdirSync, copyFileSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";

import type { SidebarTabId } from "../common/appearance";
import {
  composeLayoutCss,
  isEmptyStylesheet,
  parseLayoutStylesheet,
  type LayoutStylesheet,
} from "../common/stylesheet";
import { dataRoot } from "./paths";

/**
 * Owns the unified layout's stylesheet.
 *
 * The file lives in the data directory, seeded from the copy shipped with the
 * app, and is watched for changes. That matters more than it sounds: Discord's
 * class names are hashes that change on every deploy, so this stylesheet will
 * need editing, and editing it should not mean a rebuild. Save the file and
 * the running app picks it up.
 */
export class LayoutStyles {
  private sheet: LayoutStylesheet = { shared: "", dms: "", servers: "" };
  private watcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private listener: (() => void) | null = null;

  constructor(private readonly bundledPath: string) {
    this.seed();
    this.load();
    this.watchFile();
  }

  /** Absolute path of the editable copy, shown in the UI so it can be found. */
  get path(): string {
    return join(dataRoot(), "layout", "unified.css");
  }

  onChange(listener: () => void): void {
    this.listener = listener;
  }

  css(tab: SidebarTabId): string {
    return composeLayoutCss(this.sheet, tab);
  }

  get isEmpty(): boolean {
    return isEmptyStylesheet(this.sheet);
  }

  private seed(): void {
    if (existsSync(this.path)) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      copyFileSync(this.bundledPath, this.path);
    } catch (error) {
      console.error("[nya] could not seed the layout stylesheet:", error);
    }
  }

  private load(): void {
    const from = existsSync(this.path) ? this.path : this.bundledPath;
    try {
      this.sheet = parseLayoutStylesheet(readFileSync(from, "utf8"));
    } catch (error) {
      console.error("[nya] could not read the layout stylesheet:", error);
      this.sheet = { shared: "", dms: "", servers: "" };
    }
  }

  private watchFile(): void {
    try {
      this.watcher = watch(this.path, () => this.scheduleReload());
    } catch {
      // Watching is a convenience. A platform that cannot watch still gets the
      // stylesheet, just not live reloading.
    }
  }

  /**
   * Editors save in bursts (truncate, then write), so a single change can fire
   * several events and briefly leave the file empty. Debouncing avoids
   * reloading a half-written file.
   */
  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      this.load();
      this.listener?.();
    }, 150);
  }

  dispose(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
  }
}
