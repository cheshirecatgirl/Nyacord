import type { ChannelId } from "./channels";
import type { PrivacyPolicy } from "./policy";

/**
 * A profile is the unit of isolation. It owns a Chromium session partition,
 * which means its own cookies, localStorage, IndexedDB, cache and service
 * workers. Two profiles cannot see each other, so "work account on Stable" and
 * "personal account on Canary" are genuinely separate identities rather than
 * two tabs that share a login.
 */
export interface Profile {
  readonly id: string;
  name: string;
  channel: ChannelId;
  /**
   * Ephemeral profiles use an in-memory partition. Everything — session,
   * cache, storage — is gone when the profile is closed. This is the
   * "log in on someone else's machine" mode.
   */
  ephemeral: boolean;
  /** Optional per-profile override; when absent the global policy applies. */
  policy?: PrivacyPolicy;
  /** Injected as a user stylesheet. CSS only — never script. See docs/SECURITY.md. */
  userCss?: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface ProfileSummary {
  readonly id: string;
  readonly name: string;
  readonly channel: ChannelId;
  readonly ephemeral: boolean;
  readonly active: boolean;
  /** Unread count parsed from the document title; -1 when unknown. */
  readonly badge: number;
}

/**
 * Partition names are derived, never stored, so a corrupted config cannot
 * point a profile at an attacker-chosen partition string.
 */
export function partitionFor(profile: Pick<Profile, "id" | "ephemeral">): string {
  const safe = profile.id.replace(/[^a-zA-Z0-9_-]/g, "");
  return profile.ephemeral ? `sable-eph-${safe}` : `persist:sable-${safe}`;
}

export function newProfileId(random: () => string): string {
  return random().replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "default";
}
