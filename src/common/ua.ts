/**
 * User-Agent and client-hint normalization.
 *
 * The goal is *not* to pretend to be a different operating system. Lying about
 * the OS makes you more identifiable, not less, because a dozen other signals
 * (platform APIs, font metrics, media capabilities) still tell the truth and
 * the mismatch itself is a fingerprint.
 *
 * The goal is narrower and achievable: look like the stock Chromium build you
 * actually are, instead of announcing "Electron" and the product name — which
 * is a set of one.
 */

/** Tokens Electron appends that no browser would ever send. */
const STRIPPED_TOKENS = /\s(?:Electron|Nyacord)\/[^\s]+/g;

export function sanitizeUserAgent(raw: string, productName = "Nyacord"): string {
  const productToken = new RegExp(`\\s${escapeRegExp(productName)}\\/[^\\s]+`, "g");
  return raw.replace(STRIPPED_TOKENS, "").replace(productToken, "").replace(/\s{2,}/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function chromeMajor(chromeVersion: string): string {
  const major = chromeVersion.split(".")[0];
  return major && /^\d+$/.test(major) ? major : "0";
}

/**
 * Client hints are sent on every request and are derived from Chromium's own
 * brand list, which in Electron includes an `Electron` brand. Rewriting the
 * low-entropy hints keeps them consistent with the sanitized User-Agent.
 *
 * The GREASE brand (`Not)A;Brand`) is intentionally preserved in spirit: real
 * Chrome always emits one, so omitting it would itself stand out.
 */
export function clientHintBrands(chromeVersion: string): string {
  const v = chromeMajor(chromeVersion);
  return `"Chromium";v="${v}", "Google Chrome";v="${v}", "Not)A;Brand";v="99"`;
}

/** `Sec-CH-UA-Platform` expects a quoted, Chromium-spelled platform name. */
export function clientHintPlatform(nodePlatform: NodeJS.Platform | string): string {
  switch (nodePlatform) {
    case "win32":
      return '"Windows"';
    case "darwin":
      return '"macOS"';
    case "linux":
      return '"Linux"';
    default:
      return '"Unknown"';
  }
}

export interface ClientHintHeaders {
  "sec-ch-ua": string;
  "sec-ch-ua-mobile": string;
  "sec-ch-ua-platform": string;
}

export function clientHintHeaders(
  chromeVersion: string,
  nodePlatform: NodeJS.Platform | string,
): ClientHintHeaders {
  return {
    "sec-ch-ua": clientHintBrands(chromeVersion),
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": clientHintPlatform(nodePlatform),
  };
}

/**
 * Decides what `Referer` to send. Cross-site requests get nothing; same-site
 * requests keep the origin only, which is enough for servers that check it and
 * strictly less than the full URL Chromium would otherwise send.
 */
export function minimizedReferrer(requestUrl: string, currentReferrer: string): string | null {
  if (!currentReferrer) return null;
  try {
    const target = new URL(requestUrl);
    const referrer = new URL(currentReferrer);
    if (target.origin === referrer.origin) return referrer.origin + "/";
    return null;
  } catch {
    return null;
  }
}
