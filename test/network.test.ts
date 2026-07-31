import { strict as assert } from "node:assert";
import { test, describe } from "node:test";

import {
  defaultProxy,
  isValidPacUrl,
  isValidProxyEntry,
  isValidProxyRules,
  normalizeDns,
  normalizeProxy,
  proxyResolvesRemotely,
  proxyToElectron,
} from "../src/common/network";

describe("proxy rule validation", () => {
  test("accepts the shapes people actually use", () => {
    const valid = [
      "socks5://127.0.0.1:9050", // Tor
      "socks5://localhost:1080",
      "http://proxy.example.com:8080",
      "https://proxy.example.com:8443",
      "proxy.example.com:3128", // scheme-less
      "http=proxy:8080;https=proxy:8443", // per-scheme
      "socks5://[::1]:9050", // IPv6 literal
    ];
    for (const rules of valid) assert.equal(isValidProxyRules(rules), true, rules);
  });

  test("rejects input that would silently fail open", () => {
    const invalid = [
      "",
      "   ",
      "not a proxy",
      "socks5://host:99999", // port out of range
      "socks5://host:0",
      "ftp://host:21", // not a proxy scheme
      "gopher=host:70", // not a rule key
      "http://host:8080/path", // a proxy is host:port, not a URL path
      "socks5://user:pass@host:1080", // credentials are unsupported by Chromium
      "socks5://ho st:1080",
    ];
    for (const rules of invalid) assert.equal(isValidProxyRules(rules), false, JSON.stringify(rules));
  });

  test("rejects a rule list where only one entry is bad", () => {
    assert.equal(isValidProxyEntry("http=proxy:8080"), true);
    assert.equal(isValidProxyRules("http=proxy:8080;https=@@@"), false);
  });
});

describe("PAC url validation", () => {
  test("requires https or file", () => {
    assert.equal(isValidPacUrl("https://example.com/proxy.pac"), true);
    assert.equal(isValidPacUrl("file:///etc/proxy.pac"), true);
  });

  test("refuses plaintext http, which an on-path attacker could rewrite", () => {
    assert.equal(isValidPacUrl("http://example.com/proxy.pac"), false);
    assert.equal(isValidPacUrl("javascript:alert(1)"), false);
    assert.equal(isValidPacUrl("nonsense"), false);
  });
});

describe("normalizeProxy", () => {
  test("defaults to the system proxy", () => {
    assert.deepEqual(normalizeProxy(undefined), defaultProxy());
    assert.equal(normalizeProxy(null).mode, "system");
    assert.equal(normalizeProxy("socks5://x").mode, "system");
  });

  test("keeps a valid manual configuration", () => {
    const proxy = normalizeProxy({
      mode: "manual",
      rules: " socks5://127.0.0.1:9050 ",
      bypass: "<local>",
    });
    assert.equal(proxy.mode, "manual");
    assert.equal(proxy.rules, "socks5://127.0.0.1:9050");
    assert.equal(proxy.bypass, "<local>");
  });

  test("an invalid manual rule degrades to system, never to direct", () => {
    // This is the important one. Falling back to `direct` would send traffic
    // straight out while the user believes they are behind a proxy.
    for (const rules of ["socks5://host:99999", "not a proxy", "http://host:8080/path"]) {
      const proxy = normalizeProxy({ mode: "manual", rules });
      assert.equal(proxy.mode, "system", rules);
      assert.notEqual(proxy.mode, "direct", rules);
    }
  });

  test("a bare hostname is accepted, matching Chromium's own semantics", () => {
    // Chromium treats `proxy.example.com` as a proxy on the default port, so
    // rejecting it would refuse a configuration that genuinely works. A typo
    // here fails closed — the host does not resolve and requests fail — rather
    // than quietly falling back to a direct connection.
    assert.equal(normalizeProxy({ mode: "manual", rules: "proxy.example.com" }).mode, "manual");
  });

  test("an invalid PAC url degrades to system too", () => {
    assert.equal(normalizeProxy({ mode: "pac", pacUrl: "http://x/p.pac" }).mode, "system");
    assert.equal(normalizeProxy({ mode: "pac", pacUrl: "https://x/p.pac" }).mode, "pac");
  });

  test("clears fields that do not belong to the chosen mode", () => {
    const proxy = normalizeProxy({
      mode: "manual",
      rules: "socks5://127.0.0.1:9050",
      pacUrl: "https://example.com/p.pac",
    });
    assert.equal(proxy.pacUrl, "");
  });
});

describe("proxyToElectron", () => {
  test("maps each mode to Chromium's vocabulary", () => {
    assert.deepEqual(proxyToElectron(defaultProxy()), { mode: "system" });
    assert.deepEqual(proxyToElectron({ mode: "direct", rules: "", pacUrl: "", bypass: "" }), {
      mode: "direct",
    });
    assert.deepEqual(
      proxyToElectron({ mode: "manual", rules: "socks5://h:1", pacUrl: "", bypass: "<local>" }),
      { mode: "fixed_servers", proxyRules: "socks5://h:1", proxyBypassRules: "<local>" },
    );
    assert.deepEqual(
      proxyToElectron({ mode: "pac", rules: "", pacUrl: "https://x/p.pac", bypass: "" }),
      { mode: "pac_script", pacScript: "https://x/p.pac" },
    );
  });

  test("omits an empty bypass list rather than sending one", () => {
    const config = proxyToElectron({ mode: "manual", rules: "h:1", pacUrl: "", bypass: "" });
    assert.equal("proxyBypassRules" in config, false);
  });
});

describe("proxyResolvesRemotely", () => {
  test("is true only for SOCKS, which resolves at the proxy", () => {
    assert.equal(
      proxyResolvesRemotely({ mode: "manual", rules: "socks5://127.0.0.1:9050", pacUrl: "", bypass: "" }),
      true,
    );
    assert.equal(
      proxyResolvesRemotely({ mode: "manual", rules: "http://proxy:8080", pacUrl: "", bypass: "" }),
      false,
    );
    assert.equal(proxyResolvesRemotely(defaultProxy()), false);
  });
});

describe("normalizeDns", () => {
  test("defaults to automatic with no server of our choosing", () => {
    const dns = normalizeDns(undefined);
    assert.equal(dns.mode, "automatic");
    assert.deepEqual(dns.servers, []);
  });

  test("keeps valid https templates and drops the rest", () => {
    const dns = normalizeDns({
      mode: "secure",
      servers: [
        "https://dns.quad9.net/dns-query",
        "http://insecure.example/dns-query",
        "not a url",
        42,
      ],
    });
    assert.deepEqual(dns.servers, ["https://dns.quad9.net/dns-query"]);
    assert.equal(dns.mode, "secure");
  });

  test("secure with no usable server falls back to automatic, not to a dead resolver", () => {
    const dns = normalizeDns({ mode: "secure", servers: ["http://nope"] });
    assert.equal(dns.mode, "automatic");
  });

  test("accepts the {?dns} template form", () => {
    const dns = normalizeDns({
      mode: "secure",
      servers: ["https://dns.example.net/dns-query{?dns}"],
    });
    assert.equal(dns.servers.length, 1);
  });

  test("caps the server list", () => {
    const dns = normalizeDns({
      mode: "secure",
      servers: Array.from({ length: 9 }, (_, i) => `https://dns${i}.example/dns-query`),
    });
    assert.equal(dns.servers.length, 4);
  });
});
