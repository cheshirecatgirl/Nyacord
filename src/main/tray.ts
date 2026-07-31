import { Menu, Tray, app, nativeImage } from "electron";
import { join } from "node:path";

import { CHANNELS } from "../common/channels";
import type { AppShell } from "./window";

/**
 * The tray is what makes the client feel like a messenger rather than a web
 * page: closing the window keeps you connected, and the unread count is
 * visible without switching to it.
 */
export class AppTray {
  private tray: Tray | null = null;
  private signature = "";

  constructor(private readonly shell: AppShell) {}

  create(): void {
    const icon = nativeImage.createFromPath(join(__dirname, "..", "..", "..", "assets", "tray.png"));
    if (icon.isEmpty()) {
      console.warn("[sable] tray icon missing; running without a tray");
      return;
    }
    // macOS renders the tray icon as a template so it follows the menu bar theme.
    if (process.platform === "darwin") icon.setTemplateImage(true);

    this.tray = new Tray(icon);
    this.tray.setToolTip("Sable");
    this.tray.on("click", () => this.shell.focus());
    this.refresh();
  }

  /** True only when a tray icon actually exists to return the app from. */
  isActive(): boolean {
    return this.tray !== null;
  }

  refresh(): void {
    if (!this.tray) return;

    const profiles = this.shell.summaries();
    const total = this.shell.totalBadge();

    // Rebuilding a native menu on a timer causes visible flicker on Linux and
    // is pure waste when nothing changed, so the menu is only rebuilt when the
    // text it would render actually differs.
    const signature = profiles
      .map((p) => `${p.id}:${p.name}:${p.channel}:${p.badge}:${p.active ? 1 : 0}`)
      .join("|");
    if (signature === this.signature) return;
    this.signature = signature;

    this.tray.setToolTip(total > 0 ? `Sable — ${total} unread` : "Sable");

    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Sable", click: () => this.shell.focus() },
        { type: "separator" },
        ...profiles.map((profile) => ({
          label:
            `${profile.name} · ${CHANNELS[profile.channel].label}` +
            (profile.badge > 0 ? `  (${profile.badge})` : ""),
          type: "radio" as const,
          checked: profile.active,
          click: () => {
            this.shell.showProfile(profile.id);
            this.shell.focus();
          },
        })),
        { type: "separator" },
        { label: "Profiles…", click: () => this.shell.openPanel("profiles") },
        { label: "Privacy…", click: () => this.shell.openPanel("privacy") },
        { type: "separator" },
        // `quit`, not `exit`: `exit` skips `before-quit`, which is where the
        // config is flushed — quitting from the tray would silently discard
        // any setting changed since the last debounced write.
        { label: "Quit", click: () => app.quit() },
      ]),
    );
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
