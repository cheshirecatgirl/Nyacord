import { contextBridge, ipcRenderer } from "electron";

import { IPC, type UnlockOutcome, type VaultState } from "../common/ipc";

/**
 * The lock screen's bridge.
 *
 * It can attempt an unlock and be told the vault's public state. It cannot
 * enumerate profiles, read the ledger, change policy, or close itself: a screen
 * whose whole job is to stand between someone and your account should not also
 * be the widest surface in the app.
 *
 * The passphrase crosses this bridge in the clear, which is correct. The main
 * process is the only place a key may exist, so the renderer's job is to hand
 * the characters over and keep none of them.
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
