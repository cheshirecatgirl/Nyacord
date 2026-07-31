/**
 * Network egress configuration: proxies and DNS.
 *
 * These are the two levers that decide *who else* learns what you are doing,
 * as opposed to what Discord itself learns. A proxy decides which network your
 * traffic appears to come from. Secure DNS decides whether your resolver (an
 * ISP, a hotel, an office) gets a plaintext list of every host you contact.
 *
 * Both are validated here as pure functions, because a malformed proxy rule
 * does not fail loudly: Chromium quietly falls back to a direct connection,
 * and the user believes they are behind a proxy when they are not. That
 * failure mode is worse than an error, so bad input is rejected up front.
 */

// ---------------------------------------------------------------------- proxy

export type ProxyMode =
  /** Follow the operating system's proxy settings. Chromium's default. */
  | "system"
  /** Ignore the system settings and connect directly. */
  | "direct"
  /** Explicit proxy rules. */
  | "manual"
  /** Proxy auto-config script. */
  | "pac";

export interface ProxyConfig {
  mode: ProxyMode;
  /**
   * Chromium proxy rules. Either a single proxy (`socks5://127.0.0.1:9050`)
   * or per-scheme rules (`http=proxy:8080;https=proxy:8443`).
   */
  rules: string;
  /** URL of a PAC script, used when `mode` is `pac`. */
  pacUrl: string;
  /** Hosts that bypass the proxy, Chromium syntax (`<local>;*.example.com`). */
  bypass: string;
}

export function defaultProxy(): ProxyConfig {
  return { mode: "system", rules: "", pacUrl: "", bypass: "" };
}

const PROXY_SCHEMES = new Set(["http", "https", "socks4", "socks5", "socks"]);
/** The URL schemes a per-scheme rule may be keyed on. */
const RULE_KEYS = new Set(["http", "https", "ftp", "socks"]);

/**
 * Validates one entry of a Chromium proxy rule list.
 *
 * Deliberately strict. Credentials are rejected outright: Chromium does not
 * support them in proxy rules, so accepting `user:pass@host` would silently
 * drop the credentials *and* the user's expectation of authentication.
 */
export function isValidProxyEntry(entry: string): boolean {
  const trimmed = entry.trim();
  if (!trimmed) return false;

  let rest = trimmed;
  const eq = rest.indexOf("=");
  if (eq !== -1) {
    const key = rest.slice(0, eq).trim().toLowerCase();
    if (!RULE_KEYS.has(key)) return false;
    rest = rest.slice(eq + 1).trim();
    if (!rest) return false;
  }

  const scheme = rest.indexOf("://");
  if (scheme !== -1) {
    if (!PROXY_SCHEMES.has(rest.slice(0, scheme).toLowerCase())) return false;
    rest = rest.slice(scheme + 3);
  }

  if (rest.includes("@")) return false; // credentials are not supported
  if (rest.includes("/")) return false; // a proxy is a host:port, not a path
  if (/\s/.test(rest)) return false;

  const portSplit = rest.lastIndexOf(":");
  let host = rest;
  if (portSplit !== -1 && !rest.endsWith("]")) {
    const port = rest.slice(portSplit + 1);
    // An IPv6 literal without a port looks like `[::1]`; guard against
    // mistaking one of its colons for a port separator.
    if (!rest.startsWith("[") || rest.includes("]:")) {
      if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return false;
      host = rest.slice(0, portSplit);
    }
  }

  if (!host) return false;
  return /^[A-Za-z0-9._-]+$/.test(host) || /^\[[0-9A-Fa-f:.]+\]$/.test(host);
}

export function isValidProxyRules(rules: string): boolean {
  const entries = rules.split(";").filter((entry) => entry.trim().length > 0);
  return entries.length > 0 && entries.every(isValidProxyEntry);
}

/**
 * A PAC script is fetched and executed by Chromium, so where it comes from
 * matters. Plain HTTP is refused: an attacker on the path could rewrite the
 * script and redirect every request the browser makes.
 */
export function isValidPacUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "file:";
  } catch {
    return false;
  }
}

export function normalizeProxy(input: unknown): ProxyConfig {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const base = defaultProxy();

  const mode = raw["mode"];
  const rules = typeof raw["rules"] === "string" ? raw["rules"].trim() : "";
  const pacUrl = typeof raw["pacUrl"] === "string" ? raw["pacUrl"].trim() : "";
  const bypass = typeof raw["bypass"] === "string" ? raw["bypass"].trim() : "";

  // A mode whose required input is missing or invalid degrades to `system`
  // instead of `direct`: silently sending traffic straight out when the
  // user asked for a proxy is the one outcome we must never produce.
  if (mode === "manual") {
    if (!isValidProxyRules(rules)) return base;
    return { mode: "manual", rules, pacUrl: "", bypass };
  }
  if (mode === "pac") {
    if (!isValidPacUrl(pacUrl)) return base;
    return { mode: "pac", rules: "", pacUrl, bypass };
  }
  if (mode === "direct") return { mode: "direct", rules: "", pacUrl: "", bypass: "" };
  return base;
}

export interface ElectronProxyConfig {
  mode?: "direct" | "system" | "pac_script" | "fixed_servers";
  proxyRules?: string;
  proxyBypassRules?: string;
  pacScript?: string;
}

export function proxyToElectron(config: ProxyConfig): ElectronProxyConfig {
  switch (config.mode) {
    case "direct":
      return { mode: "direct" };
    case "manual":
      return {
        mode: "fixed_servers",
        proxyRules: config.rules,
        ...(config.bypass ? { proxyBypassRules: config.bypass } : {}),
      };
    case "pac":
      return {
        mode: "pac_script",
        pacScript: config.pacUrl,
        ...(config.bypass ? { proxyBypassRules: config.bypass } : {}),
      };
    case "system":
      return { mode: "system" };
  }
}

export function describeProxy(config: ProxyConfig): string {
  switch (config.mode) {
    case "direct":
      return "Direct connection";
    case "manual":
      return config.rules;
    case "pac":
      return `PAC: ${config.pacUrl}`;
    case "system":
      return "System proxy settings";
  }
}

/**
 * SOCKS5 resolves hostnames at the proxy, so DNS does not leak locally. The
 * HTTP proxy schemes do not, which the UI says out loud instead of
 * leaving it as folklore.
 */
export function proxyResolvesRemotely(config: ProxyConfig): boolean {
  if (config.mode !== "manual") return false;
  return /(^|[;=])\s*socks[45]?:\/\//i.test(config.rules);
}

// ------------------------------------------------------------------------ dns

export type SecureDnsMode =
  /** Plain DNS via the system resolver. */
  | "off"
  /** Upgrade to DoH when the system resolver is known to support it. */
  | "automatic"
  /** DoH only. Resolution fails instead of falling back to plaintext. */
  | "secure";

export interface DnsConfig {
  mode: SecureDnsMode;
  /** DoH server templates, e.g. `https://dns.quad9.net/dns-query`. */
  servers: string[];
}

export function defaultDns(): DnsConfig {
  return { mode: "automatic", servers: [] };
}

export function isValidDohServer(template: string): boolean {
  try {
    const parsed = new URL(template.replace("{?dns}", ""));
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * `secure` with no servers configured would leave Chromium unable to resolve
 * anything at all, so it is downgraded to `automatic`. Failing closed is the
 * right instinct in general, but a client that cannot resolve any host is not
 * secure, it is broken, and someone facing a dead app turns the whole feature
 * off instead of fixing one field.
 */
export function normalizeDns(input: unknown): DnsConfig {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const servers = Array.isArray(raw["servers"])
    ? (raw["servers"] as unknown[])
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim())
        .filter(isValidDohServer)
        .slice(0, 4)
    : [];

  const mode = raw["mode"];
  if (mode === "off") return { mode: "off", servers };
  if (mode === "secure") {
    return servers.length > 0 ? { mode: "secure", servers } : { mode: "automatic", servers };
  }
  return { mode: "automatic", servers };
}
