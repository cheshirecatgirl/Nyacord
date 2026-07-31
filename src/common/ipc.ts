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

import type { AppearanceConfig } from "./appearance";
import type { ChannelId } from "./channels";
import type { DnsConfig } from "./network";
import type { PrivacyPolicy } from "./policy";
import type { ProfileSummary } from "./profile";
import type { RuleCategory } from "./rules";

export const IPC = {
  getState: "nyacord:get-state",
  setPolicy: "nyacord:set-policy",
  applyPreset: "nyacord:apply-preset",
  createProfile: "nyacord:create-profile",
  switchProfile: "nyacord:switch-profile",
  renameProfile: "nyacord:rename-profile",
  deleteProfile: "nyacord:delete-profile",
  clearProfileData: "nyacord:clear-profile-data",
  setProfileProxy: "nyacord:set-profile-proxy",
  setDns: "nyacord:set-dns",
  setAppearance: "nyacord:set-appearance",
  openChat: "nyacord:open-chat",
  getLedger: "nyacord:get-ledger",
  clearLedger: "nyacord:clear-ledger",
  closePanel: "nyacord:close-panel",
  reloadActive: "nyacord:reload-active",
  openExternal: "nyacord:open-external",
  // main -> renderer
  stateChanged: "nyacord:state-changed",
  ledgerChanged: "nyacord:ledger-changed",
  showPane: "nyacord:show-pane",
} as const;

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
