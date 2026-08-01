import { contextBridge, ipcRenderer } from "electron";

import type { SidebarTabId } from "../common/appearance";
import { IPC, type SwitcherState } from "../common/ipc";

/**
 * The switcher strip's bridge: two methods, because the strip does two things.
 *
 * It is a separate bridge from the settings panel's on purpose. The strip is
 * the one piece of our UI that sits over Discord's page all the time, so it
 * gets the smallest surface in the application rather than the largest.
 */
const api = {
  /**
   * `restoreFocus` hands focus back to the Discord view after the change.
   * A click on the strip focuses it, which would otherwise mean the message
   * box quietly stops receiving keystrokes. Keyboard selection passes false,
   * because yanking focus away mid-arrow-key is the opposite of helpful.
   */
  select: (tab: SidebarTabId, restoreFocus: boolean): Promise<boolean> =>
    ipcRenderer.invoke(IPC.setActiveTab, tab, restoreFocus),

  onState: (listener: (state: SwitcherState) => void): void => {
    ipcRenderer.on(IPC.switcherState, (_event, state: SwitcherState) => listener(state));
  },
};

export type NyaSwitcherApi = typeof api;

contextBridge.exposeInMainWorld("nyaSwitcher", api);
