import { contextBridge, ipcRenderer } from "electron";

import type { SidebarTabId } from "../common/appearance";
import { IPC, type SwitcherState } from "../common/ipc";

/**
 * The switcher strip's bridge. Separate from the settings panel's: the strip
 * is the one piece of our UI that sits over Discord's page all the time, so it
 * gets the smallest surface in the app.
 */
const api = {
  /**
   * `restoreFocus` returns focus to Discord after the change. Clicking the
   * strip focuses it, which would otherwise stop the message box taking
   * keystrokes. Keyboard selection passes false so arrow keys keep working.
   */
  select: (tab: SidebarTabId, restoreFocus: boolean): Promise<boolean> =>
    ipcRenderer.invoke(IPC.setActiveTab, tab, restoreFocus),

  onState: (listener: (state: SwitcherState) => void): void => {
    ipcRenderer.on(IPC.switcherState, (_event, state: SwitcherState) => listener(state));
  },
};

export type NyaSwitcherApi = typeof api;

contextBridge.exposeInMainWorld("nyaSwitcher", api);
