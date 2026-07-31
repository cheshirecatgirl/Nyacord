/**
 * The complete IPC surface between the privileged main process and the shell
 * UI renderer.
 *
 * Every channel is listed here and nowhere else. The preload exposes exactly
 * these and nothing generic — no `invoke(anyChannel, …)` escape hatch — so the
 * attack surface reachable from renderer JavaScript is bounded by this file.
 *
 * Note that the Discord view has *no* preload at all and therefore cannot
 * reach any of this.
 */

import type { ChannelId } from "./channels";
import type { PrivacyPolicy } from "./policy";
import type { ProfileSummary } from "./profile";
import type { RuleCategory } from "./rules";

export const IPC = {
  getState: "sable:get-state",
  setPolicy: "sable:set-policy",
  applyPreset: "sable:apply-preset",
  createProfile: "sable:create-profile",
  switchProfile: "sable:switch-profile",
  renameProfile: "sable:rename-profile",
  deleteProfile: "sable:delete-profile",
  clearProfileData: "sable:clear-profile-data",
  setProfileProxy: "sable:set-profile-proxy",
  getLedger: "sable:get-ledger",
  clearLedger: "sable:clear-ledger",
  closePanel: "sable:close-panel",
  reloadActive: "sable:reload-active",
  openExternal: "sable:open-external",
  // main -> renderer
  stateChanged: "sable:state-changed",
  ledgerChanged: "sable:ledger-changed",
  showPane: "sable:show-pane",
} as const;

export type PaneId = "profiles" | "privacy" | "network" | "inspector" | "about";

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
  readonly policy: PrivacyPolicy;
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
