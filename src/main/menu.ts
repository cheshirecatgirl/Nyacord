import { Menu, type MenuItemConstructorOptions } from "electron";

import type { AppShell } from "./window";

/**
 * Shortcuts live here, not as global accelerators, so Nyacord never captures
 * keys while another application is focused.
 *
 * The Settings menu lists the panes in the same order as the panel's own
 * sidebar, so the two never disagree about where anything is.
 */
export function buildMenu(shell: AppShell): void {
  const isMac = process.platform === "darwin";

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? ([{ role: "appMenu" }] satisfies MenuItemConstructorOptions[]) : []),
    {
      label: "&Settings",
      submenu: [
        { label: "Profiles", accelerator: "CmdOrCtrl+P", click: () => shell.openPanel("profiles") },
        {
          label: "Privacy & Security",
          accelerator: "CmdOrCtrl+,",
          click: () => shell.openPanel("privacy"),
        },
        {
          label: "Network",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => shell.openPanel("network"),
        },
        {
          label: "Inspector",
          accelerator: "CmdOrCtrl+Shift+I",
          click: () => shell.openPanel("inspector"),
        },
        {
          label: "Appearance",
          accelerator: "CmdOrCtrl+Shift+A",
          click: () => shell.openPanel("appearance"),
        },
        { type: "separator" },
        { label: "About", click: () => shell.openPanel("about") },
        { type: "separator" },
        ...(isMac ? [] : ([{ role: "quit" }] satisfies MenuItemConstructorOptions[])),
      ],
    },
    {
      label: "&Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "&View",
      submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => shell.reloadActive() },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
