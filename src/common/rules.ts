/**
 * The request classifier.
 *
 * This module is deliberately pure: it takes a URL, a method and a Chromium
 * resource type, and returns a verdict. No Electron, no I/O. That makes the
 * blocking behaviour of the client directly unit-testable, which is the whole
 * point: the blocking behaviour has to be verifiable without launching a
 * browser.
 */

import { isActivityHost, isDiscordOwnedHost, hostMatchesSuffix } from "./channels";
import type { PrivacyPolicy } from "./policy";

export type RuleCategory =
  | "telemetry"
  | "error-reporting"
  | "third-party-tracker"
  | "browser-service"
  | "ghost-typing"
  | "ghost-read-receipt"
  | "ghost-call-report"
  | "activity"
  | "third-party-media";

export interface RequestFacts {
  readonly url: string;
  readonly method: string;
  /** Chromium resource type, e.g. `xhr`, `image`, `websocket`, `mainFrame`. */
  readonly resourceType: string;
}

export interface Verdict {
  readonly blocked: boolean;
  readonly category?: RuleCategory;
  /** Human-readable justification, surfaced verbatim in the Privacy Inspector. */
  readonly reason?: string;
}

const ALLOWED: Verdict = { blocked: false };

/** Matches `/api/v9/…`, `/api/v10/…` and the version-less `/api/…` form. */
const API_PREFIX = /^\/api\/(?:v\d+\/)?/;

function apiPath(pathname: string): string | null {
  const match = API_PREFIX.exec(pathname);
  return match ? pathname.slice(match[0].length) : null;
}

/** Discord's analytics ingest. `science` is the current name; the others are legacy or adjacent. */
const TELEMETRY_ENDPOINTS = new Set(["science", "track", "metrics", "analytics"]);

/** Hosts that exist purely to observe you. Suffix-matched. */
const TRACKER_SUFFIXES: readonly string[] = [
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "scorecardresearch.com",
  "connect.facebook.net",
  "facebook.com",
  "branch.io",
  "app-measurement.com",
  "amplitude.com",
  "segment.io",
  "segment.com",
  "mixpanel.com",
  "adjust.com",
  "appsflyer.com",
];

/** Crash/error aggregation. Sentry is what Discord actually uses. */
const ERROR_REPORTING_SUFFIXES: readonly string[] = ["sentry.io", "bugsnag.com", "crashlytics.com"];

/**
 * Chromium's own network chatter: component updater, dictionary download,
 * Safe Browsing, optimization hints. None of it is Discord and none of it is
 * needed to run a chat client.
 */
const BROWSER_SERVICE_SUFFIXES: readonly string[] = [
  "gvt1.com",
  "gvt2.com",
  "clients2.google.com",
  "clients3.google.com",
  "update.googleapis.com",
  "safebrowsing.googleapis.com",
  "optimizationguide-pa.googleapis.com",
  "content-autofill.googleapis.com",
  "accounts.google.com",
  "gstatic.com",
];

function isErrorReporting(host: string, pathname: string): boolean {
  if (ERROR_REPORTING_SUFFIXES.some((s) => hostMatchesSuffix(host, s))) return true;
  if (pathname.includes("/error-reporting")) return true;
  if (pathname.startsWith("/_/sentry")) return true;
  const api = apiPath(pathname);
  return api !== null && (api === "reporting" || api.startsWith("reporting/"));
}

/**
 * `POST /channels/{id}/typing` is the only thing that broadcasts the typing
 * indicator. Nothing else depends on it, so dropping it is invisible locally.
 */
const TYPING_RE = /^channels\/\d+\/typing$/;

/**
 * Acknowledgements. Discord has several shapes: per-message ack, bulk ack
 * across channels, and a guild-wide "mark server read".
 */
const ACK_RES: readonly RegExp[] = [
  /^channels\/\d+\/messages\/\d+\/ack$/,
  /^channels\/\d+\/ack$/,
  /^guilds\/\d+\/ack$/,
  /^read-states\/ack-bulk$/,
];

/** Post-call quality telemetry uploaded by the voice stack. */
const CALL_REPORT_RES: readonly RegExp[] = [
  /^rtc\/quality-report$/,
  /^science\/rtc/,
  /^voice\/quality/,
];

/**
 * Resource types that fetch remote content for display. Blocking these when
 * they point off-Discord is what stops an embedded image from turning into an
 * IP-logging beacon.
 */
const MEDIA_RESOURCE_TYPES = new Set(["image", "media", "font", "stylesheet", "object"]);

/**
 * Classify a single request against the active policy.
 *
 * Order matters: the cheapest and most specific checks run first, and the
 * broad "third-party media" sweep runs last so that a request which is already
 * explained by a precise rule is attributed to that rule in the ledger.
 */
export function classify(facts: RequestFacts, policy: PrivacyPolicy): Verdict {
  let url: URL;
  try {
    url = new URL(facts.url);
  } catch {
    return ALLOWED;
  }

  // Non-HTTP schemes (devtools:, blob:, data:, file:) are not network traffic.
  if (url.protocol !== "https:" && url.protocol !== "http:") return ALLOWED;

  const host = url.hostname;
  const path = url.pathname;
  const method = facts.method.toUpperCase();
  const api = apiPath(path);
  const discordOwned = isDiscordOwnedHost(host);

  if (policy.blockTelemetry && discordOwned && api !== null) {
    const head = api.split("/")[0] ?? "";
    if (TELEMETRY_ENDPOINTS.has(head)) {
      return {
        blocked: true,
        category: "telemetry",
        reason: `Discord analytics endpoint /api/${head}`,
      };
    }
  }

  if (policy.blockErrorReporting && isErrorReporting(host, path)) {
    return { blocked: true, category: "error-reporting", reason: "Crash/error reporting upload" };
  }

  if (policy.ghost.enabled && discordOwned && api !== null) {
    if (policy.ghost.suppressTyping && method === "POST" && TYPING_RE.test(api)) {
      return { blocked: true, category: "ghost-typing", reason: "Ghost mode: typing indicator" };
    }
    if (policy.ghost.suppressReadReceipts && method === "POST" && ACK_RES.some((re) => re.test(api))) {
      return {
        blocked: true,
        category: "ghost-read-receipt",
        reason: "Ghost mode: read acknowledgement",
      };
    }
    if (policy.ghost.suppressCallReports && CALL_REPORT_RES.some((re) => re.test(api))) {
      return {
        blocked: true,
        category: "ghost-call-report",
        reason: "Ghost mode: call quality report",
      };
    }
  }

  if (policy.blockActivities && isActivityHost(host)) {
    return { blocked: true, category: "activity", reason: "Embedded activity (third-party code)" };
  }

  if (policy.blockThirdPartyTrackers && TRACKER_SUFFIXES.some((s) => hostMatchesSuffix(host, s))) {
    return { blocked: true, category: "third-party-tracker", reason: `Known tracker: ${host}` };
  }

  if (policy.blockBrowserServices && BROWSER_SERVICE_SUFFIXES.some((s) => hostMatchesSuffix(host, s))) {
    return { blocked: true, category: "browser-service", reason: `Browser background service: ${host}` };
  }

  if (
    policy.blockThirdPartyMedia &&
    !discordOwned &&
    !isActivityHost(host) &&
    MEDIA_RESOURCE_TYPES.has(facts.resourceType)
  ) {
    return {
      blocked: true,
      category: "third-party-media",
      reason: `Off-platform ${facts.resourceType} from ${host}`,
    };
  }

  return ALLOWED;
}

export const RULE_CATEGORY_LABELS: Readonly<Record<RuleCategory, string>> = {
  telemetry: "Telemetry",
  "error-reporting": "Error reporting",
  "third-party-tracker": "Third-party trackers",
  "browser-service": "Browser services",
  "ghost-typing": "Typing indicator",
  "ghost-read-receipt": "Read receipts",
  "ghost-call-report": "Call reports",
  activity: "Activities",
  "third-party-media": "Off-platform media",
};
