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
} as const;

/**
 * Everything the switcher strip is allowed to know.
 *
 * Deliberately not `AppState`. The strip sits over Discord's own sidebar and
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
