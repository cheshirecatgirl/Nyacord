/**
 * The complete IPC surface between the privileged main process and the shell
 * UI renderer.
 *
 * Every channel is listed here and nowhere else. The preload exposes exactly
 * these and nothing generic. There is no `invoke(anyChannel, …)` escape hatch,
 * so this file bounds what renderer JavaScript can reach.
 *
 * The Discord view has no preload at all, so it cannot reach any of this.
 */

import type { AppearanceConfig, SidebarTabId } from "./appearance";
import type { ChannelId } from "./channels";
import type { DnsConfig } from "./network";
import type { PrivacyPolicy } from "./policy";
import type { ProfileSummary } from "./profile";
import type { RuleCategory } from "./rules";

export const IPC = {
  getState: "nya:get-state",
  setPolicy: "nya:set-policy",
  applyPreset: "nya:apply-preset",
  createProfile: "nya:create-profile",
  switchProfile: "nya:switch-profile",
  renameProfile: "nya:rename-profile",
  deleteProfile: "nya:delete-profile",
  clearProfileData: "nya:clear-profile-data",
  setProfileProxy: "nya:set-profile-proxy",
  setDns: "nya:set-dns",
  setAppearance: "nya:set-appearance",
  setActiveTab: "nya:set-active-tab",
  // vault
  unlockVault: "nya:unlock-vault",
  enableVault: "nya:enable-vault",
  changePassphrase: "nya:change-passphrase",
  disableVault: "nya:disable-vault",
  setAutoLock: "nya:set-auto-lock",
  lockNow: "nya:lock-now",
  getLedger: "nya:get-ledger",
  clearLedger: "nya:clear-ledger",
  closePanel: "nya:close-panel",
  reloadActive: "nya:reload-active",
  openExternal: "nya:open-external",
  // main -> renderer
  stateChanged: "nya:state-changed",
  ledgerChanged: "nya:ledger-changed",
  showPane: "nya:show-pane",
  switcherState: "nya:switcher-state",
  vaultChanged: "nya:vault-changed",
} as const;

/**
 * What the lock screen and the settings panel are told about the vault.
 *
 * No salt, no verifier, no key material: this crosses into a renderer, so it
 * carries only what a UI needs to draw itself and nothing that would help
 * anybody guess a passphrase.
 */
export interface VaultState {
  /** A passphrase has been set. */
  readonly enabled: boolean;
  /** The key is in memory and profile data is usable. */
  readonly open: boolean;
  /** The sealed file is currently the authoritative copy. */
  readonly sealed: boolean;
  readonly failures: number;
  /** Milliseconds before another attempt is accepted; 0 means now. */
  readonly retryInMs: number;
  /** Minutes of inactivity before re-locking; 0 disables it. */
  readonly autoLockMinutes: number;
  /** A previous run ended without sealing, so readable data was left on disk. */
  readonly leftUnsealed: boolean;
}

/**
 * The answer to an unlock attempt, as the lock screen sees it.
 *
 * "wrong-passphrase" and "corrupt" are kept apart. They call for
 * different things from the user, and collapsing them into "failed" is how
 * someone spends an evening retyping a passphrase that was right all along.
 */
export type UnlockOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "wrong-passphrase" | "corrupt" | "locked-out";
      readonly retryInMs: number;
    };

/**
 * Everything the switcher strip is allowed to know.
 *
 * Not `AppState`. The strip sits over Discord's own sidebar and
 * needs two facts to draw itself, so it gets two facts; profiles, policy and
 * the ledger stay on the settings panel's side of the bridge.
 */
export interface SwitcherState {
  readonly activeTab: SidebarTabId;
  /** Whether to draw for a dark surface. The strip's background is the page. */
  readonly dark: boolean;
}

export type PaneId =
  | "profiles"
  | "privacy"
  | "vault"
  | "network"
  | "appearance"
  | "inspector"
  | "about";

export interface LedgerEntry {
  readonly at: number;
  readonly profileId: string;
  readonly category: RuleCategory;
  readonly reason: string;
  readonly url: string;
  readonly method: string;
}

export interface LedgerSnapshot {
  readonly totals: Partial<Record<RuleCategory, number>>;
  readonly recent: readonly LedgerEntry[];
  readonly since: number;
}

export interface AppState {
  readonly version: string;
  readonly electron: string;
  readonly chrome: string;
  readonly portable: boolean;
  readonly portableReason: string;
  readonly dataDir: string;
  readonly layoutStylesheet: string;
  readonly policy: PrivacyPolicy;
  readonly dns: DnsConfig;
  readonly appearance: AppearanceConfig;
  readonly vault: VaultState;
  readonly profiles: readonly ProfileSummary[];
  readonly activeProfileId: string | null;
  /** True when the build has an unsafe developer switch enabled. */
  readonly devMode: boolean;
}

export interface CreateProfileRequest {
  readonly name: string;
  readonly channel: ChannelId;
  readonly ephemeral: boolean;
}
