import type { ChannelId } from "./channels";
import type { ProxyConfig } from "./network";
import type { PrivacyPolicy } from "./policy";

/**
 * The unit of isolation. A profile owns a Chromium session partition: its own
 * cookies, localStorage, IndexedDB, cache and service workers. Two profiles
 * cannot see each other, so "work on Stable" and "personal on Canary" are
 * separate identities, not two tabs sharing a login.
 */
export interface Profile {
  readonly id: string;
  name: string;
  channel: ChannelId;
  /** In-memory partition: session, cache and storage vanish on close. */
  ephemeral: boolean;
  /** Optional per-profile override; when absent the global policy applies. */
  policy?: PrivacyPolicy;
  /**
   * Egress. Chromium attaches proxies to sessions, which makes a profile the
   * right granularity: one identity over Tor, another direct.
   */
  proxy?: ProxyConfig;
  /** Injected as a user stylesheet. CSS only, never script. See docs/SECURITY.md. */
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
  readonly proxy: ProxyConfig;
}

/**
 * Partition names are derived, never stored, so a corrupted config cannot
 * point a profile at an attacker-chosen partition string.
 */
export function partitionFor(profile: Pick<Profile, "id" | "ephemeral">): string {
  const safe = profile.id.replace(/[^a-zA-Z0-9_-]/g, "");
  return profile.ephemeral ? `nya-eph-${safe}` : `persist:nya-${safe}`;
}

export function newProfileId(random: () => string): string {
  return random().replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "default";
}

/**
 * Discord writes the unread count into the document title as `(3) #general`.
 * Reading it needs no script injection, which is how a client that runs no
 * code in the page has a badge at all.
 */
export function parseBadgeFromTitle(title: string): number {
  const match = /^\((\d+)\)/.exec(title.trim());
  if (!match?.[1]) return 0;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : 0;
}
