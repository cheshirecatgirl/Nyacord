/**
 * End-to-end regression suite.
 *
 * Every bug fixed in this project so far was found by running the app, not by
 * reading it or by unit-testing the pure modules: a sandboxed preload that
 * could not resolve its imports, a panel that opened on the wrong pane, a
 * "delete" that did not delete, a window that could not be re-shown. None of
 * those are reachable from a pure function, so none of them were catchable by
 * `test/*.test.ts`.
 *
 * Each test below corresponds to one of those bugs. They are the guard that
 * stops them coming back.
 *
 * Requires a display (use `xvfb-run` on a headless machine) and a non-root
 * user, because Chromium's sandbox refuses to run as root.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

import type { AppState } from "../../src/common/ipc";
import type { DnsConfig, ProxyConfig } from "../../src/common/network";
import type { SableApi } from "../../src/preload/shell";

declare global {
  // The bridge the preload installs, as the panel's own scripts see it.
  interface Window {
    sable: SableApi;
  }
}

/** The `electron` package's Node-side export is the path to the binary. */
const electronPath = require("electron") as unknown as string;

const projectRoot = join(__dirname, "..", "..", "..");

let app: ElectronApplication;
let panel: Page;
let dataDir: string;

/** Console output that would indicate a broken page rather than a broken test. */
const pageProblems: string[] = [];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The Discord view as seen from inside a main-process `evaluate`. Electron's
 * `View` type does not expose `webContents`, and the callback is compiled here
 * rather than where it runs.
 */
interface MainView {
  webContents: {
    loadURL(url: string): Promise<void>;
    session: { resolveProxy(url: string): Promise<string> };
  };
}

/** Polls until `check` returns something truthy, so tests do not race the UI. */
async function until<T>(check: () => Promise<T> | T, timeoutMs = 15_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value) return value as NonNullable<T>;
      last = value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting; last saw ${String(last)}`);
    await wait(200);
  }
}

/** Reads the state the main process would hand the UI. */
function state(): Promise<AppState> {
  return panel.evaluate(() => window.sable.getState());
}

before(async () => {
  // A throwaway portable directory keeps the suite off the developer's real
  // config and exercises the `--data-dir` path at the same time.
  dataDir = mkdtempSync(join(tmpdir(), "sable-e2e-"));

  app = await electron.launch({
    executablePath: electronPath,
    cwd: projectRoot,
    args: [projectRoot, `--data-dir=${dataDir}`],
    timeout: 60_000,
  });

  // Attach before the panel exists so nothing is missed on first load.
  app.on("window", (page) => {
    page.on("pageerror", (error) => pageProblems.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") pageProblems.push(`console: ${message.text()}`);
    });
  });

  // Open the Network pane specifically: asking for a non-default pane on the
  // very first open is what exposed the showPane race.
  await until(async () => {
    const opened = await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      const sable = menu?.items.find((item) => (item.label || "").includes("Sable"));
      const entry = sable?.submenu?.items.find((item) => (item.label || "").startsWith("Network"));
      if (!entry) return false;
      entry.click();
      return true;
    });
    return opened;
  });

  panel = await until(() => app.windows().find((page) => page.url().includes("shell.html")));

  // `attached`, not `visible`: we opened the Network pane on purpose, so the
  // Profiles pane is display:none and its rows are correctly not visible.
  await panel.waitForSelector("#profile-list li", { state: "attached", timeout: 20_000 });
});

after(async () => {
  await app?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe("startup", () => {
  test("opens a window with a default profile", async () => {
    const info = await app.evaluate(({ BaseWindow }) => {
      const windows = BaseWindow.getAllWindows();
      return { count: windows.length, title: windows[0]?.getTitle() ?? "" };
    });
    assert.equal(info.count, 1);
    assert.match(info.title, /Stable/);

    const current = await state();
    assert.equal(current.profiles.length, 1);
    assert.equal(current.profiles[0]?.channel, "stable");
  });

  test("honours --data-dir, so portable mode is real", async () => {
    const current = await state();
    assert.equal(current.portable, true);
    assert.equal(current.portableReason, "explicit-path");
    assert.equal(current.dataDir, dataDir);
  });

  test("exposes the preload bridge", async () => {
    // A sandboxed preload cannot `require` relative modules; when that broke,
    // `window.sable` silently never appeared and the panel stayed empty.
    assert.equal(await panel.evaluate(() => typeof window.sable), "object");
  });

  test("opens on the pane that was requested, not the default one", async () => {
    assert.equal(await panel.$eval(".tab.active", (el) => el.textContent), "Network");
  });
});

describe("profiles", () => {
  test("creates a profile on another release channel", async () => {
    const id = await panel.evaluate(() =>
      window.sable.createProfile({ name: "E2E Canary", channel: "canary", ephemeral: false }),
    );
    assert.ok(id);

    const created = await until(async () =>
      (await state()).profiles.find((profile) => profile.id === id),
    );
    assert.equal(created.channel, "canary");
    assert.equal(created.name, "E2E Canary");
  });

  test("deletes a profile and removes it from state", async () => {
    // The delete path also wipes the profile's session; the confirmation the
    // user sees promises both, and for a while only the config entry went.
    const id = await panel.evaluate(() =>
      window.sable.createProfile({ name: "Doomed", channel: "ptb", ephemeral: false }),
    );
    assert.ok(id);
    await until(async () => (await state()).profiles.some((profile) => profile.id === id));

    assert.equal(await panel.evaluate((target) => window.sable.deleteProfile(target), id), true);
    await until(async () => !(await state()).profiles.some((profile) => profile.id === id));
  });

  test("keeps at least one profile so there is never a dead end", async () => {
    assert.ok((await state()).profiles.length >= 1);
  });
});

describe("privacy policy", () => {
  test("applies a preset", async () => {
    await panel.evaluate(() => window.sable.applyPreset("paranoid"));
    const current = await until(async () => {
      const next = await state();
      return next.policy.preset === "paranoid" ? next : null;
    });
    assert.equal(current.policy.blockThirdPartyMedia, true);
    assert.equal(current.policy.ghost.enabled, true);
  });

  test("changing DNS does not flip the privacy preset", async () => {
    // DNS is a network decision that outlives a privacy preset. Routing it
    // through setPolicy used to silently mark the whole policy "custom".
    const dns: DnsConfig = { mode: "secure", servers: ["https://dns.quad9.net/dns-query"] };
    const stored = await panel.evaluate((value) => window.sable.setDns(value), dns);
    assert.deepEqual(stored, dns);
    assert.equal((await state()).policy.preset, "paranoid");
  });

  test("refuses secure DNS with no usable server rather than killing resolution", async () => {
    const stored = await panel.evaluate(() =>
      window.sable.setDns({ mode: "secure", servers: ["http://not-secure.example"] }),
    );
    assert.equal(stored.mode, "automatic");
  });
});

describe("request filtering", () => {
  test("blocks the analytics endpoint and records it", async () => {
    const error = await app
      .evaluate(({ BaseWindow }) => {
        const view = BaseWindow.getAllWindows()[0]?.contentView.children[0] as unknown as MainView;
        return view.webContents.loadURL("https://discord.com/api/v9/science");
      })
      .then(() => "")
      .catch((e: Error) => e.message);

    assert.match(error, /ERR_BLOCKED_BY_CLIENT/);

    const snapshot = await until(async () => {
      const ledger = await panel.evaluate(() => window.sable.getLedger());
      return ledger.recent.some((entry) => entry.category === "telemetry") ? ledger : null;
    });
    assert.ok((snapshot.totals.telemetry ?? 0) > 0);
  });
});

describe("proxy", () => {
  test("a SOCKS proxy is genuinely used by Chromium", async () => {
    const active = (await state()).profiles.find((profile) => profile.active);
    assert.ok(active);

    const requested: ProxyConfig = {
      mode: "manual",
      rules: "socks5://127.0.0.1:9050",
      pacUrl: "",
      bypass: "",
    };
    const stored = await panel.evaluate(
      ([id, proxy]) => window.sable.setProfileProxy(id as string, proxy as ProxyConfig),
      [active.id, requested] as const,
    );
    assert.equal(stored?.mode, "manual");

    // Ask Chromium itself, rather than trusting that we stored a setting.
    const resolved = await app.evaluate(({ BaseWindow }) => {
      const view = BaseWindow.getAllWindows()[0]?.contentView.children[0] as unknown as MainView;
      return view.webContents.session.resolveProxy("https://discord.com/app");
    });
    assert.match(resolved, /SOCKS5 127\.0\.0\.1:9050/);
  });

  test("an invalid rule falls back to the system proxy, never to direct", async () => {
    // Falling back to `direct` would send traffic straight out while the user
    // believes they are proxied. That is the failure this guards.
    const active = (await state()).profiles.find((profile) => profile.active);
    assert.ok(active);

    const stored = await panel.evaluate(
      (id) =>
        window.sable.setProfileProxy(id as string, {
          mode: "manual",
          rules: "socks5://host:99999",
          pacUrl: "",
          bypass: "",
        }),
      active.id,
    );
    assert.equal(stored?.mode, "system");
    assert.notEqual(stored?.mode, "direct");
  });
});

describe("window lifecycle", () => {
  test("closing hides the window instead of destroying it", async () => {
    // Destroying it left `activate` focusing a dead object and, without a tray
    // icon, no way back into the app at all.
    const result = await app.evaluate(async ({ BaseWindow }) => {
      const win = BaseWindow.getAllWindows()[0];
      win?.close();
      await new Promise((resolve) => setTimeout(resolve, 800));
      const remaining = BaseWindow.getAllWindows();
      return {
        count: remaining.length,
        destroyed: remaining[0]?.isDestroyed() ?? true,
        visible: remaining[0]?.isVisible() ?? true,
      };
    });

    assert.equal(result.count, 1);
    assert.equal(result.destroyed, false);
    assert.equal(result.visible, false);
  });

  test("the hidden window can be brought back", async () => {
    const visible = await app.evaluate(({ BaseWindow }) => {
      const win = BaseWindow.getAllWindows()[0];
      win?.show();
      return win?.isVisible() ?? false;
    });
    assert.equal(visible, true);
  });
});

describe("panel hygiene", () => {
  test("produces no page errors and no CSP violations", async () => {
    // The panel sets a strict CSP; violating it in our own markup would mean
    // shipping a policy we do not comply with.
    assert.deepEqual(pageProblems, []);
  });
});
