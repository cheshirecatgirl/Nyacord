import { contextBridge, ipcRenderer } from "electron";

import { IPC, type UnlockOutcome, type VaultState } from "../common/ipc";

/**
 * The lock screen's bridge: attempt an unlock, be told the vault's public
 * state. It cannot enumerate profiles, read the ledger, change policy or
 * dismiss itself.
 *
 * The passphrase crosses in the clear, which is right. Keys exist only in the
 * main process, so the renderer hands the characters over and keeps none.
 */
const api = {
  unlock: (passphrase: string): Promise<UnlockOutcome> =>
    ipcRenderer.invoke(IPC.unlockVault, passphrase),

  onState: (listener: (state: VaultState) => void): void => {
    ipcRenderer.on(IPC.vaultChanged, (_event, state: VaultState) => listener(state));
  },
};

export type NyaLockApi = typeof api;

contextBridge.exposeInMainWorld("nyaLock", api);
