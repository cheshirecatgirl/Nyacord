/**
 * Discord ships three public release channels. Each one is a separate origin
 * with its own cookies, its own build pipeline and its own session, so Sable
 * treats them as first-class targets rather than as a hidden setting.
 */

export type ChannelId = "stable" | "ptb" | "canary";

export interface ChannelDef {
  readonly id: ChannelId;
  readonly label: string;
  readonly host: string;
  readonly origin: string;
  /** Entry point. `/app` skips the marketing landing page. */
  readonly appUrl: string;
  /** Used to tint the profile chrome so you always know which build you are in. */
  readonly accent: string;
  readonly description: string;
}

export const CHANNELS: Readonly<Record<ChannelId, ChannelDef>> = {
  stable: {
    id: "stable",
    label: "Stable",
    host: "discord.com",
    origin: "https://discord.com",
    appUrl: "https://discord.com/app",
    accent: "#5865f2",
    description: "The production build. Fewest surprises.",
  },
  ptb: {
    id: "ptb",
    label: "PTB",
    host: "ptb.discord.com",
    origin: "https://ptb.discord.com",
    appUrl: "https://ptb.discord.com/app",
    accent: "#3ba55d",
    description: "Public Test Build. Features that are close to shipping.",
  },
  canary: {
    id: "canary",
    label: "Canary",
    host: "canary.discord.com",
    origin: "https://canary.discord.com",
    appUrl: "https://canary.discord.com/app",
    accent: "#faa61a",
    description: "Bleeding edge, updated constantly, breaks often.",
  },
};

export const CHANNEL_IDS: readonly ChannelId[] = ["stable", "ptb", "canary"];

export function isChannelId(value: unknown): value is ChannelId {
  return typeof value === "string" && value in CHANNELS;
}

export function channel(id: ChannelId): ChannelDef {
  return CHANNELS[id];
}

/**
 * Hosts that belong to Discord itself. Used both by the navigation guard and
 * by the "block everything third-party" privacy tier.
 *
 * Matching is suffix-based on a dot boundary so that `evil-discord.com` does
 * not match `discord.com`.
 */
const DISCORD_SUFFIXES: readonly string[] = [
  "discord.com",
  "discordapp.com",
  "discordapp.net",
  "discord.gg",
  "discord.media",
  "discord.dev",
];

export function hostMatchesSuffix(host: string, suffix: string): boolean {
  const h = host.toLowerCase();
  const s = suffix.toLowerCase();
  return h === s || h.endsWith("." + s);
}

export function isDiscordOwnedHost(host: string): boolean {
  return DISCORD_SUFFIXES.some((suffix) => hostMatchesSuffix(host, suffix));
}

/**
 * Embedded activities are served from `*.discordsays.com`, which is Discord's
 * sandbox domain for third-party mini-apps. They are Discord-adjacent but they
 * are *not* Discord code, so they get their own classification.
 */
export function isActivityHost(host: string): boolean {
  return hostMatchesSuffix(host, "discordsays.com");
}

/**
 * Top-level navigation is only ever allowed to stay inside the channel the
 * profile was created for. Anything else is handed to the OS browser.
 */
export function isNavigableHost(host: string, def: ChannelDef): boolean {
  return host.toLowerCase() === def.host;
}
