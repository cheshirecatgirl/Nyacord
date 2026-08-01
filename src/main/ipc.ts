import { ipcMain } from "electron";

import { isChannelId } from "../common/channels";
import { IPC, type CreateProfileRequest } from "../common/ipc";
import { isSidebarTab, normalizeAppearance } from "../common/appearance";
import { normalizeDns } from "../common/network";
import { normalizePolicy, presetPolicy, type PresetName } from "../common/policy";
import type { NyaConfig } from "./config";
import type { ProfileStore } from "./profiles";
import type { PrivacyLedger } from "./privacy/ledger";
import { openExternalSafely } from "./security/session";
import type { JsonStore } from "./store";
import type { AppShell } from "./window";

/**
 * Every handler treats its argument as hostile. The shell renderer is ours and
 * is sandboxed, but "the privileged side validates" is the only assumption
 * that survives a renderer compromise.
 */
export function registerIpc(
  shell: AppShell,
  config: JsonStore<NyaConfig>,
  profiles: ProfileStore,
  ledger: PrivacyLedger,
  /** Re-applies the process-wide host resolver configuration. */
  onDnsChanged: () => void,
): void {
  ipcMain.handle(IPC.getState, () => shell.state());

  ipcMain.handle(IPC.setPolicy, (_event, policy: unknown) => {
    const next = normalizePolicy(policy);
    next.preset = "custom";
    config.update((draft) => {
      draft.policy = next;
    });
    shell.pushState();
    return next;
  });

  ipcMain.handle(IPC.applyPreset, (_event, name: unknown) => {
    if (name !== "balanced" && name !== "strict" && name !== "paranoid") return null;
    const policy = presetPolicy(name as Exclude<PresetName, "custom">);
    config.update((draft) => {
      draft.policy = policy;
    });
    shell.pushState();
    return policy;
  });

  ipcMain.handle(IPC.setDns, (_event, dns: unknown) => {
    const next = normalizeDns(dns);
    config.update((draft) => {
      draft.dns = next;
    });
    onDnsChanged();
    shell.pushState();
    return next;
  });

  ipcMain.handle(IPC.createProfile, (_event, request: unknown) => {
    const req = request as Partial<CreateProfileRequest>;
    if (!isChannelId(req?.channel)) return null;
    const profile = profiles.create({
      name: typeof req.name === "string" ? req.name : "",
      channel: req.channel,
      ephemeral: req.ephemeral === true,
    });
    shell.showProfile(profile.id);
    return profile.id;
  });

  ipcMain.handle(IPC.switchProfile, (_event, id: unknown) => {
    if (typeof id !== "string") return false;
    shell.showProfile(id);
    return true;
  });

  ipcMain.handle(IPC.renameProfile, (_event, id: unknown, name: unknown) => {
    if (typeof id !== "string" || typeof name !== "string") return false;
    profiles.rename(id, name);
    shell.pushState();
    return true;
  });

  ipcMain.handle(IPC.deleteProfile, async (_event, id: unknown) => {
    if (typeof id !== "string" || !profiles.find(id)) return false;
    await shell.deleteProfile(id);
    return true;
  });

  ipcMain.handle(IPC.clearProfileData, async (_event, id: unknown) => {
    if (typeof id !== "string" || !profiles.find(id)) return false;
    await shell.clearProfileData(id);
    return true;
  });

  ipcMain.handle(IPC.setAppearance, (_event, appearance: unknown) => {
    const next = normalizeAppearance(appearance);
    config.update((draft) => {
      draft.appearance = next;
    });
    shell.applyLayout();
    shell.pushState();
    // Return the normalized value so the UI can show what was stored. Entries
    // with an unusable target are dropped and that should be visible.
    return next;
  });

  // The switcher strip's only capability. Narrower than setAppearance on
  // purpose: the strip can move between sides, not change the layout mode.
  ipcMain.handle(IPC.setActiveTab, (_event, tab: unknown, restoreFocus: unknown) => {
    if (!isSidebarTab(tab)) return false;
    shell.setActiveTab(tab, restoreFocus === true);
    return true;
  });

  ipcMain.handle(IPC.setProfileProxy, async (_event, id: unknown, proxy: unknown) => {
    if (typeof id !== "string" || !profiles.find(id)) return null;
    // An invalid rule degrades to the system proxy. Returning the stored
    // value lets the UI say so instead of appearing to accept it.
    return shell.setProfileProxy(id, proxy);
  });

  ipcMain.handle(IPC.getLedger, (_event, profileId: unknown) =>
    ledger.snapshot(typeof profileId === "string" ? profileId : undefined),
  );

  ipcMain.handle(IPC.clearLedger, () => {
    ledger.clear();
    return true;
  });

  ipcMain.handle(IPC.closePanel, () => {
    shell.closePanel();
    return true;
  });

  ipcMain.handle(IPC.reloadActive, () => {
    shell.reloadActive();
    return true;
  });

  ipcMain.handle(IPC.openExternal, (_event, url: unknown) => {
    if (typeof url !== "string") return false;
    openExternalSafely(url);
    return true;
  });
}
