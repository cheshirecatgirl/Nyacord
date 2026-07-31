import { ipcMain } from "electron";

import { isChannelId } from "../common/channels";
import { IPC, type CreateProfileRequest } from "../common/ipc";
import { normalizePolicy, presetPolicy, type PresetName } from "../common/policy";
import type { SableConfig } from "./config";
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
  config: JsonStore<SableConfig>,
  profiles: ProfileStore,
  ledger: PrivacyLedger,
  /** Re-applies process-wide settings (secure DNS) that a policy change affects. */
  onPolicyChanged: () => void,
): void {
  ipcMain.handle(IPC.getState, () => shell.state());

  ipcMain.handle(IPC.setPolicy, (_event, policy: unknown) => {
    const next = normalizePolicy(policy);
    next.preset = "custom";
    config.update((draft) => {
      draft.policy = next;
    });
    onPolicyChanged();
    shell.pushState();
    return next;
  });

  ipcMain.handle(IPC.applyPreset, (_event, name: unknown) => {
    if (name !== "balanced" && name !== "strict" && name !== "paranoid") return null;
    const policy = presetPolicy(name as Exclude<PresetName, "custom">);
    config.update((draft) => {
      // A preset must not silently reset the user's DNS choice: it is a
      // network-level decision that outlives a privacy preset.
      draft.policy = { ...policy, dns: draft.policy.dns };
    });
    onPolicyChanged();
    shell.pushState();
    return config.get().policy;
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

  ipcMain.handle(IPC.deleteProfile, (_event, id: unknown) => {
    if (typeof id !== "string") return false;
    shell.closeProfileView(id);
    profiles.remove(id);
    const next = profiles.activeId();
    if (next) shell.showProfile(next);
    shell.pushState();
    return true;
  });

  ipcMain.handle(IPC.clearProfileData, async (_event, id: unknown) => {
    if (typeof id !== "string" || !profiles.find(id)) return false;
    await shell.clearProfileData(id);
    return true;
  });

  ipcMain.handle(IPC.setProfileProxy, async (_event, id: unknown, proxy: unknown) => {
    if (typeof id !== "string" || !profiles.find(id)) return null;
    // The normalized result is returned so the UI can show what was actually
    // stored — an invalid rule degrades to the system proxy rather than being
    // accepted and silently ignored.
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
