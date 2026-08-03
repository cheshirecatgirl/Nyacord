import { balancedPolicy, normalizePolicy, type PrivacyPolicy } from "../common/policy";
import { isChannelId } from "../common/channels";
import {
  defaultAppearance,
  normalizeAppearance,
  type AppearanceConfig,
} from "../common/appearance";
import { defaultDns, normalizeDns, normalizeProxy, type DnsConfig } from "../common/network";
import type { Profile } from "../common/profile";
import { configFile } from "./paths";
import { JsonStore } from "./store";

export interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
}

export interface NyaConfig {
  /** Bumped when a migration is needed; unknown future versions fall back to defaults. */
  version: number;
  policy: PrivacyPolicy;
  /**
   * Secure DNS lives beside the privacy policy, not inside it. The host
   * resolver is process-wide, so unlike everything in `policy` it can never be
   * overridden per profile. Keeping it separate also means switching privacy
   * preset does not quietly reset a network decision made once.
   */
  dns: DnsConfig;
  appearance: AppearanceConfig;
  profiles: Profile[];
  activeProfileId: string | null;
  window: WindowBounds;
}

export const CONFIG_VERSION = 1;

export function defaultConfig(): NyaConfig {
  return {
    version: CONFIG_VERSION,
    policy: balancedPolicy(),
    /**
     * Not a specific provider. Routing every lookup to a resolver
     * we picked would move your DNS from one third party to another of our
     * choosing, without asking. `automatic` upgrades to DoH when your own
     * resolver supports it; naming a server is opt-in.
     */
    dns: defaultDns(),
    appearance: defaultAppearance(),
    profiles: [],
    activeProfileId: null,
    window: { width: 1280, height: 800, maximized: false },
  };
}

/**
 * Config on disk is untrusted input: it may be hand-edited, half-written by an
 * older build, or restored from a different machine. Everything is re-validated
 * instead of cast.
 */
function sanitize(config: NyaConfig): NyaConfig {
  const base = defaultConfig();
  const profiles = Array.isArray(config.profiles)
    ? config.profiles.filter(isPlausibleProfile).map((profile) => ({
        ...profile,
        policy: profile.policy ? normalizePolicy(profile.policy) : undefined,
        proxy: normalizeProxy(profile.proxy),
      }))
    : [];

  const activeProfileId =
    typeof config.activeProfileId === "string" &&
    profiles.some((p) => p.id === config.activeProfileId)
      ? config.activeProfileId
      : (profiles[0]?.id ?? null);

  const win = typeof config.window === "object" && config.window !== null ? config.window : base.window;

  return {
    version: CONFIG_VERSION,
    policy: normalizePolicy(config.policy),
    dns: normalizeDns(config.dns),
    appearance: normalizeAppearance(config.appearance),
    profiles,
    activeProfileId,
    window: {
      width: clamp(win.width, 480, 10_000, base.window.width),
      height: clamp(win.height, 360, 10_000, base.window.height),
      x: Number.isFinite(win.x) ? win.x : undefined,
      y: Number.isFinite(win.y) ? win.y : undefined,
      maximized: win.maximized === true,
    },
  };
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}

function isPlausibleProfile(value: unknown): value is Profile {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Partial<Profile>;
  return (
    typeof p.id === "string" &&
    /^[a-zA-Z0-9_-]{1,32}$/.test(p.id) &&
    typeof p.name === "string" &&
    isChannelId(p.channel)
  );
}

export function openConfig(): JsonStore<NyaConfig> {
  const store = new JsonStore<NyaConfig>(configFile(), defaultConfig);
  store.replace(sanitize(store.get() as NyaConfig));
  return store;
}
