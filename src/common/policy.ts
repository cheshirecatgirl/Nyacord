/**
 * The privacy policy is a single plain object. Everything the client does to
 * protect you — request filtering, permission answers, header rewriting,
 * WebRTC behaviour — is derived from it, so there is exactly one place to read
 * if you want to know what the client will actually do.
 */

export type PermissionDecision = "allow" | "ask" | "deny";

/**
 * The permissions Nyacord is willing to have an opinion about. Anything Chromium
 * asks for that is not on this list is denied outright and logged.
 */
export const PERMISSION_KEYS = [
  "media", // camera + microphone
  "display-capture", // screen share
  "notifications",
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
  "pointerLock",
  "geolocation",
  "midi",
  "midiSysex",
  "hid",
  "serial",
  "usb",
  "bluetooth",
  "idle-detection",
  "window-management",
  "openExternal",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export type WebRtcPolicy =
  /** Chromium default: may expose LAN candidates to the peer. */
  | "default"
  /** Only the interface used for the default route. Hides other LAN adapters/VPN split. */
  | "public_interface_only"
  /** No non-proxied UDP at all. Most private, most likely to degrade voice. */
  | "disable_non_proxied_udp";

export type PresetName = "balanced" | "strict" | "paranoid" | "custom";

export interface GhostPolicy {
  /** Master switch. When false the individual toggles are ignored. */
  enabled: boolean;
  /** Drop `POST /channels/{id}/typing` so the "… is typing" bubble never fires. */
  suppressTyping: boolean;
  /** Drop message-ack requests so the server is never told you read something. */
  suppressReadReceipts: boolean;
  /** Drop the voice/video quality report Discord uploads after a call. */
  suppressCallReports: boolean;
}

export interface PrivacyPolicy {
  preset: PresetName;

  /** The `science`, `track` and `metrics` API endpoints — Discord's own analytics pipeline. */
  blockTelemetry: boolean;
  /** Sentry and Discord's crash/error ingestion endpoints. */
  blockErrorReporting: boolean;
  /** Known third-party analytics hosts (GA, GTM, DoubleClick, …). */
  blockThirdPartyTrackers: boolean;
  /** Chromium's own phone-home surfaces: component updates, spellcheck fetch, SafeBrowsing. */
  blockBrowserServices: boolean;
  /** Embedded activities (`*.discordsays.com`) run third-party code. */
  blockActivities: boolean;
  /**
   * Refuse to load subresources from hosts Discord does not own. Stops link
   * previews and embeds from revealing your IP to arbitrary servers, at the
   * cost of some images not rendering.
   */
  blockThirdPartyMedia: boolean;

  ghost: GhostPolicy;

  /** Strip the `Electron/…` and product tokens from the User-Agent. */
  sanitizeUserAgent: boolean;
  /** Rewrite `Sec-CH-UA*` so client hints agree with the sanitized UA. */
  normalizeClientHints: boolean;
  /** Send `Referer` only for same-site requests. */
  minimizeReferrer: boolean;
  /** Ask sites not to sell/share (`Sec-GPC: 1`). */
  globalPrivacyControl: boolean;

  webrtc: WebRtcPolicy;

  /** Chromium's spellchecker downloads dictionaries from Google on first use. */
  spellcheck: boolean;

  permissions: Record<PermissionKey, PermissionDecision>;
}

function permissions(
  overrides: Partial<Record<PermissionKey, PermissionDecision>>,
  fallback: PermissionDecision,
): Record<PermissionKey, PermissionDecision> {
  const out = {} as Record<PermissionKey, PermissionDecision>;
  for (const key of PERMISSION_KEYS) out[key] = overrides[key] ?? fallback;
  return out;
}

/**
 * `balanced` is the shipping default: everything that is unambiguously
 * tracking is gone, and nothing a normal user relies on is broken.
 */
export function balancedPolicy(): PrivacyPolicy {
  return {
    preset: "balanced",
    blockTelemetry: true,
    blockErrorReporting: true,
    blockThirdPartyTrackers: true,
    blockBrowserServices: true,
    blockActivities: false,
    blockThirdPartyMedia: false,
    ghost: {
      enabled: false,
      suppressTyping: true,
      suppressReadReceipts: false,
      suppressCallReports: true,
    },
    sanitizeUserAgent: true,
    normalizeClientHints: true,
    minimizeReferrer: true,
    globalPrivacyControl: true,
    webrtc: "public_interface_only",
    spellcheck: false,
    permissions: permissions(
      {
        media: "ask",
        "display-capture": "ask",
        notifications: "ask",
        "clipboard-sanitized-write": "allow",
        fullscreen: "allow",
        pointerLock: "allow",
        openExternal: "ask",
      },
      "deny",
    ),
  };
}

/** `strict` also drops embedded activities and asks before every capability. */
export function strictPolicy(): PrivacyPolicy {
  const base = balancedPolicy();
  return {
    ...base,
    preset: "strict",
    blockActivities: true,
    ghost: { ...base.ghost, enabled: true, suppressReadReceipts: true },
    permissions: permissions(
      {
        media: "ask",
        "display-capture": "ask",
        notifications: "ask",
        fullscreen: "allow",
        pointerLock: "allow",
        openExternal: "ask",
      },
      "deny",
    ),
  };
}

/**
 * `paranoid` trades functionality for exposure. Third-party media is blocked,
 * WebRTC will not use non-proxied UDP, and nothing is granted implicitly.
 */
export function paranoidPolicy(): PrivacyPolicy {
  const base = strictPolicy();
  return {
    ...base,
    preset: "paranoid",
    blockThirdPartyMedia: true,
    webrtc: "disable_non_proxied_udp",
    ghost: {
      enabled: true,
      suppressTyping: true,
      suppressReadReceipts: true,
      suppressCallReports: true,
    },
    permissions: permissions({ fullscreen: "allow" }, "ask"),
  };
}

export function presetPolicy(name: Exclude<PresetName, "custom">): PrivacyPolicy {
  switch (name) {
    case "balanced":
      return balancedPolicy();
    case "strict":
      return strictPolicy();
    case "paranoid":
      return paranoidPolicy();
  }
}

/**
 * Merges a stored (possibly stale or partial) policy onto a known-good base.
 * Unknown keys are dropped and malformed values fall back rather than throw,
 * so a hand-edited or downgraded config file can never brick startup.
 */
export function normalizePolicy(input: unknown): PrivacyPolicy {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const presetName = raw["preset"];
  const base =
    presetName === "strict" || presetName === "paranoid" || presetName === "balanced"
      ? presetPolicy(presetName)
      : balancedPolicy();

  const bool = (key: keyof PrivacyPolicy, fallback: boolean): boolean =>
    typeof raw[key] === "boolean" ? (raw[key] as boolean) : fallback;

  const rawGhost = (typeof raw["ghost"] === "object" && raw["ghost"] !== null
    ? raw["ghost"]
    : {}) as Record<string, unknown>;
  const ghostBool = (key: keyof GhostPolicy, fallback: boolean): boolean =>
    typeof rawGhost[key] === "boolean" ? (rawGhost[key] as boolean) : fallback;

  const rawPerms = (typeof raw["permissions"] === "object" && raw["permissions"] !== null
    ? raw["permissions"]
    : {}) as Record<string, unknown>;
  const perms = {} as Record<PermissionKey, PermissionDecision>;
  for (const key of PERMISSION_KEYS) {
    const value = rawPerms[key];
    perms[key] =
      value === "allow" || value === "ask" || value === "deny" ? value : base.permissions[key];
  }

  const webrtc = raw["webrtc"];

  return {
    preset: presetName === "custom" ? "custom" : base.preset,
    blockTelemetry: bool("blockTelemetry", base.blockTelemetry),
    blockErrorReporting: bool("blockErrorReporting", base.blockErrorReporting),
    blockThirdPartyTrackers: bool("blockThirdPartyTrackers", base.blockThirdPartyTrackers),
    blockBrowserServices: bool("blockBrowserServices", base.blockBrowserServices),
    blockActivities: bool("blockActivities", base.blockActivities),
    blockThirdPartyMedia: bool("blockThirdPartyMedia", base.blockThirdPartyMedia),
    ghost: {
      enabled: ghostBool("enabled", base.ghost.enabled),
      suppressTyping: ghostBool("suppressTyping", base.ghost.suppressTyping),
      suppressReadReceipts: ghostBool("suppressReadReceipts", base.ghost.suppressReadReceipts),
      suppressCallReports: ghostBool("suppressCallReports", base.ghost.suppressCallReports),
    },
    sanitizeUserAgent: bool("sanitizeUserAgent", base.sanitizeUserAgent),
    normalizeClientHints: bool("normalizeClientHints", base.normalizeClientHints),
    minimizeReferrer: bool("minimizeReferrer", base.minimizeReferrer),
    globalPrivacyControl: bool("globalPrivacyControl", base.globalPrivacyControl),
    webrtc:
      webrtc === "default" || webrtc === "public_interface_only" || webrtc === "disable_non_proxied_udp"
        ? webrtc
        : base.webrtc,
    spellcheck: bool("spellcheck", base.spellcheck),
    permissions: perms,
  };
}
