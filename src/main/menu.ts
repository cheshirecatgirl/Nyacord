import { Menu, app, type MenuItemConstructorOptions } from "electron";

import type { AppShell } from "./window";

/**
 * The application menu doubles as the keyboard-shortcut table. Shortcuts are
 * registered here rather than as global accelerators so that Nyacord never
 * captures keys while another application is focused.
 */
export function buildMenu(shell: AppShell): void {
  const isMac = process.platform === "darwin";

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([{ role: "appMenu" }] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: "&Nyacord",
      submenu: [
        {
          label: "Profiles…",
          accelerator: "CmdOrCtrl+P",
          click: () => shell.openPanel("profiles"),
        },
        {
          label: "Privacy settings…",
          accelerator: "CmdOrCtrl+,",
          click: () => shell.openPanel("privacy"),
        },
        {
          label: "Network…",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => shell.openPanel("network"),
        },
        {
          label: "Appearance…",
          accelerator: "CmdOrCtrl+Shift+A",
          click: () => shell.openPanel("appearance"),
        },
        {
          label: "Privacy inspector…",
          accelerator: "CmdOrCtrl+Shift+I",
          click: () => shell.openPanel("inspector"),
        },
        { type: "separator" },
        {
          label: "Reload Discord view",
          accelerator: "CmdOrCtrl+R",
          click: () => shell.reloadActive(),
        },
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
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "&Help",
      submenu: [
        { label: "About Nyacord", click: () => shell.openPanel("about") },
        { label: `Version ${app.getVersion()}`, enabled: false },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
