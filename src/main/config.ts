import { balancedPolicy, normalizePolicy, type PrivacyPolicy } from "../common/policy";
import { isChannelId } from "../common/channels";
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

export interface SableConfig {
  /** Bumped when a migration is needed; unknown future versions fall back to defaults. */
  version: number;
  policy: PrivacyPolicy;
  profiles: Profile[];
  activeProfileId: string | null;
  window: WindowBounds;
}

export const CONFIG_VERSION = 1;

export function defaultConfig(): SableConfig {
  return {
    version: CONFIG_VERSION,
    policy: balancedPolicy(),
    profiles: [],
    activeProfileId: null,
    window: { width: 1280, height: 800, maximized: false },
  };
}

/**
 * Config on disk is untrusted input: it may be hand-edited, half-written by an
 * older build, or restored from a different machine. Everything is re-validated
 * rather than cast.
 */
function sanitize(config: SableConfig): SableConfig {
  const base = defaultConfig();
  const profiles = Array.isArray(config.profiles)
    ? config.profiles.filter(isPlausibleProfile).map((profile) => ({
        ...profile,
        policy: profile.policy ? normalizePolicy(profile.policy) : undefined,
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

export function openConfig(): JsonStore<SableConfig> {
  const store = new JsonStore<SableConfig>(configFile(), defaultConfig);
  store.replace(sanitize(store.get() as SableConfig));
  return store;
}
