import { session, shell, type Session } from "electron";

import type { ChannelDef } from "../../common/channels";
import { proxyToElectron, type ProxyConfig } from "../../common/network";
import type { PermissionKey, PrivacyPolicy } from "../../common/policy";
import { classify } from "../../common/rules";
import { clientHintHeaders, minimizedReferrer, sanitizeUserAgent } from "../../common/ua";
import type { PrivacyLedger } from "../privacy/ledger";

/**
 * Everything that hardens a Chromium session lives here: request filtering,
 * header rewriting, permission answers, and the device pickers.
 *
 * A session is configured once when its profile is created and then re-read
 * from `getPolicy()` on every decision, so toggling a setting takes effect on
 * the next request rather than requiring a restart.
 */

export interface SessionContext {
  readonly profileId: string;
  readonly channel: ChannelDef;
  readonly getPolicy: () => PrivacyPolicy;
  readonly ledger: PrivacyLedger;
  /** Asks the user; resolves to the decision. Used when a permission is set to "ask". */
  readonly prompt: (permission: PermissionKey, origin: string) => Promise<boolean>;
  readonly proxy: ProxyConfig;
}

/**
 * Chromium hands us permission strings that do not all appear in our policy
 * (they vary by version). Unknown permissions are denied — fail closed.
 */
function toPermissionKey(permission: string): PermissionKey | null {
  switch (permission) {
    case "media":
    case "audioCapture":
    case "videoCapture":
      return "media";
    case "display-capture":
      return "display-capture";
    case "notifications":
      return "notifications";
    case "clipboard-read":
      return "clipboard-read";
    case "clipboard-sanitized-write":
      return "clipboard-sanitized-write";
    case "fullscreen":
      return "fullscreen";
    case "pointerLock":
      return "pointerLock";
    case "geolocation":
      return "geolocation";
    case "midi":
      return "midi";
    case "midiSysex":
      return "midiSysex";
    case "hid":
      return "hid";
    case "serial":
      return "serial";
    case "usb":
      return "usb";
    case "bluetooth":
      return "bluetooth";
    case "idle-detection":
      return "idle-detection";
    case "window-management":
    case "window-placement":
      return "window-management";
    case "openExternal":
      return "openExternal";
    default:
      return null;
  }
}

export function configureSession(partition: string, ctx: SessionContext): Session {
  const ses = session.fromPartition(partition);
  applyUserAgent(ses, ctx);
  applyRequestFilter(ses, ctx);
  applyHeaderPolicy(ses, ctx);
  applyPermissions(ses, ctx);
  applyDevicePolicy(ses);
  ses.setSpellCheckerEnabled(ctx.getPolicy().spellcheck);
  void applyProxy(ses, ctx.proxy);
  return ses;
}

/**
 * Erases everything a session holds: cookies, storage, caches, and the HTTP
 * auth cache that would otherwise re-authenticate silently.
 *
 * Resolved from the partition rather than from a live view, so it works for a
 * profile that has never been opened — otherwise "sign out" on an unopened
 * profile would appear to succeed while leaving the session intact.
 */
export async function wipeSessionData(partition: string): Promise<void> {
  const ses = session.fromPartition(partition);
  await ses.clearStorageData();
  await ses.clearCache();
  await ses.clearAuthCache();
}

/**
 * Applied per session, which is what makes a proxy a per-profile setting.
 *
 * `forceReloadProxyConfig` matters on a change: without it Chromium may keep
 * using resolved proxy state for connections it has already pooled, and the
 * user would see a mixture of old and new egress with no indication why.
 */
export async function applyProxy(ses: Session, proxy: ProxyConfig): Promise<void> {
  try {
    await ses.setProxy(proxyToElectron(proxy));
    await ses.forceReloadProxyConfig();
    await ses.closeAllConnections();
  } catch (error) {
    console.error("[nyacord] failed to apply proxy:", error);
  }
}

function applyUserAgent(ses: Session, ctx: SessionContext): void {
  if (!ctx.getPolicy().sanitizeUserAgent) return;
  ses.setUserAgent(sanitizeUserAgent(ses.getUserAgent()));
}

function applyRequestFilter(ses: Session, ctx: SessionContext): void {
  ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    const verdict = classify(
      { url: details.url, method: details.method, resourceType: details.resourceType },
      ctx.getPolicy(),
    );

    if (!verdict.blocked) {
      callback({ cancel: false });
      return;
    }

    ctx.ledger.record({
      at: Date.now(),
      profileId: ctx.profileId,
      category: verdict.category ?? "telemetry",
      reason: verdict.reason ?? "blocked",
      url: details.url,
      method: details.method,
    });
    callback({ cancel: true });
  });
}

function applyHeaderPolicy(ses: Session, ctx: SessionContext): void {
  const hints = clientHintHeaders(process.versions.chrome ?? "0", process.platform);

  ses.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
    const policy = ctx.getPolicy();
    const headers = { ...details.requestHeaders };

    if (policy.normalizeClientHints) {
      for (const [name, value] of Object.entries(hints)) {
        // Only rewrite hints Chromium already decided to send; adding new ones
        // to a request that had none would itself be a distinguishing signal.
        const existing = findHeader(headers, name);
        if (existing) headers[existing] = value;
      }
      // Discord's own debug header is only meaningful to their engineers and
      // marks the request as coming from something unusual.
      const debugHeader = findHeader(headers, "x-debug-options");
      if (debugHeader) delete headers[debugHeader];
    }

    if (policy.minimizeReferrer) {
      const referer = findHeader(headers, "referer");
      if (referer) {
        const replacement = minimizedReferrer(details.url, String(headers[referer] ?? ""));
        if (replacement === null) delete headers[referer];
        else headers[referer] = replacement;
      }
    }

    if (policy.globalPrivacyControl) headers["Sec-GPC"] = "1";

    callback({ requestHeaders: headers });
  });
}

function findHeader(headers: Record<string, unknown>, name: string): string | null {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) if (key.toLowerCase() === target) return key;
  return null;
}

function applyPermissions(ses: Session, ctx: SessionContext): void {
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const origin = originOf(details?.requestingUrl ?? contents?.getURL() ?? "");
    void decide(permission, origin, ctx).then(callback);
  });

  /**
   * `setPermissionCheckHandler` answers the synchronous `navigator.permissions`
   * query path. Without it a site can observe a "granted" state that the
   * request handler would actually refuse — and, more importantly, Chromium
   * defaults some checks to allow.
   */
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    const key = toPermissionKey(permission);
    if (!key) return false;
    if (!isTrustedOrigin(requestingOrigin, ctx)) return false;
    return ctx.getPolicy().permissions[key] === "allow";
  });
}

async function decide(permission: string, origin: string, ctx: SessionContext): Promise<boolean> {
  const key = toPermissionKey(permission);
  if (!key) return false;
  if (!isTrustedOrigin(origin, ctx)) return false;

  switch (ctx.getPolicy().permissions[key]) {
    case "allow":
      return true;
    case "deny":
      return false;
    case "ask":
      return ctx.prompt(key, origin);
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/**
 * Only the channel's own origin may request capabilities. An iframe from an
 * embedded activity or an ad network gets nothing, silently.
 */
function isTrustedOrigin(origin: string, ctx: SessionContext): boolean {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    return host === ctx.channel.host;
  } catch {
    return false;
  }
}

function applyDevicePolicy(ses: Session): void {
  // WebHID / WebSerial / WebUSB are refused outright. Discord has no need for
  // them and they are the highest-severity capabilities a page can hold.
  ses.setDevicePermissionHandler(() => false);
  ses.setBluetoothPairingHandler((_details, callback) => callback({ confirmed: false }));
  ses.setUSBProtectedClassesHandler(() => []);
}

/**
 * Applied to every session: refuse to hand a renderer anything the OS shell
 * could act on without our knowledge.
 */
export function openExternalSafely(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:" && parsed.protocol !== "mailto:") {
    return;
  }
  void shell.openExternal(parsed.toString());
}
