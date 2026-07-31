import { contextBridge, ipcRenderer } from "electron";

import { IPC, type AppState, type CreateProfileRequest, type LedgerSnapshot, type PaneId } from "../common/ipc";
import type { AppearanceConfig } from "../common/appearance";
import type { DnsConfig, ProxyConfig } from "../common/network";
import type { PrivacyPolicy } from "../common/policy";

/**
 * The only bridge in the application, and it is attached to our own local UI —
 * never to Discord.
 *
 * Each method is a named, fixed-arity wrapper. There is deliberately no
 * generic `invoke(channel, …)`: if a future feature needs a new capability it
 * has to be added here and in `common/ipc.ts`, which makes the privileged
 * surface reviewable as a diff.
 */
const api = {
  getState: (): Promise<AppState> => ipcRenderer.invoke(IPC.getState),

  setPolicy: (policy: PrivacyPolicy): Promise<PrivacyPolicy> =>
    ipcRenderer.invoke(IPC.setPolicy, policy),

  applyPreset: (name: string): Promise<PrivacyPolicy | null> =>
    ipcRenderer.invoke(IPC.applyPreset, name),

  createProfile: (request: CreateProfileRequest): Promise<string | null> =>
    ipcRenderer.invoke(IPC.createProfile, request),

  switchProfile: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.switchProfile, id),

  renameProfile: (id: string, name: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.renameProfile, id, name),

  deleteProfile: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.deleteProfile, id),

  clearProfileData: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.clearProfileData, id),

  setProfileProxy: (id: string, proxy: ProxyConfig): Promise<ProxyConfig | null> =>
    ipcRenderer.invoke(IPC.setProfileProxy, id, proxy),

  setDns: (dns: DnsConfig): Promise<DnsConfig> => ipcRenderer.invoke(IPC.setDns, dns),

  setAppearance: (appearance: AppearanceConfig): Promise<AppearanceConfig> =>
    ipcRenderer.invoke(IPC.setAppearance, appearance),

  openChat: (target: string): Promise<boolean> => ipcRenderer.invoke(IPC.openChat, target),

  getLedger: (profileId?: string): Promise<LedgerSnapshot> =>
    ipcRenderer.invoke(IPC.getLedger, profileId),

  clearLedger: (): Promise<boolean> => ipcRenderer.invoke(IPC.clearLedger),

  closePanel: (): Promise<boolean> => ipcRenderer.invoke(IPC.closePanel),

  reloadActive: (): Promise<boolean> => ipcRenderer.invoke(IPC.reloadActive),

  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke(IPC.openExternal, url),

  /**
   * Listeners receive only the payload. The `IpcRendererEvent` is withheld
   * because it carries `sender`, which would hand the renderer a route back
   * into the main process.
   */
  onStateChanged: (listener: (state: AppState) => void): void => {
    ipcRenderer.on(IPC.stateChanged, (_event, state: AppState) => listener(state));
  },

  onLedgerChanged: (listener: (snapshot: LedgerSnapshot) => void): void => {
    ipcRenderer.on(IPC.ledgerChanged, (_event, snapshot: LedgerSnapshot) => listener(snapshot));
  },

  onShowPane: (listener: (pane: PaneId) => void): void => {
    ipcRenderer.on(IPC.showPane, (_event, pane: PaneId) => listener(pane));
  },
};

export type SableApi = typeof api;

contextBridge.exposeInMainWorld("sable", api);
