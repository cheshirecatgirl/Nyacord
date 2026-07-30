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

  refresh(): void {
    if (!this.tray) return;

    const profiles = this.shell.summaries();
    const total = this.shell.totalBadge();

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
        { label: "Quit", click: () => app.exit(0) },
      ]),
    );
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
