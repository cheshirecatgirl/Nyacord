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
import type { NyaApi } from "../../src/preload/shell";
import type { NyaSwitcherApi } from "../../src/preload/switcher";

declare global {
  // The bridges the preloads install, as each page's own scripts see them.
  interface Window {
    nya: NyaApi;
    nyaSwitcher: NyaSwitcherApi;
  }
}

/** The `electron` package's Node-side export is the path to the binary. */
const electronPath = require("electron") as unknown as string;

const projectRoot = join(__dirname, "..", "..", "..");

let app: ElectronApplication;
let panel: Page;
let dataDir: string;

/** Console output that would indicate a broken page, not a broken test. */
const pageProblems: string[] = [];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A child view as seen from inside a main-process `evaluate`. Electron's
 * `View` type does not expose `webContents`, and the callback is compiled here
 * not where it runs.
 */
interface MainView {
  webContents: {
    getURL(): string;
    loadURL(url: string): Promise<void>;
    executeJavaScript(code: string): Promise<unknown>;
    session: { resolveProxy(url: string): Promise<string> };
  };
}

/**
 * The Discord view is picked out of the window's children by being the only one
 * that is not a `file://` page of ours. Indexing used to be enough, but the
 * window now also holds the switcher strip, and views change order as they are
 * raised over each other.
 *
 * The predicate is repeated at each call site rather than shared, because
 * `app.evaluate` ships only the callback's own source to the main process and
 * nothing it closes over comes with it.
 */

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
  return panel.evaluate(() => window.nya.getState());
}

before(async () => {
  // A throwaway portable directory keeps the suite off the developer's real
  // config and exercises the `--data-dir` path at the same time.
  dataDir = mkdtempSync(join(tmpdir(), "nya-e2e-"));

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
      const nya = menu?.items.find((item) => (item.label || "").includes("Settings"));
      const entry = nya?.submenu?.items.find((item) => (item.label || "").startsWith("Network"));
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
    // `window.nya` silently never appeared and the panel stayed empty.
    assert.equal(await panel.evaluate(() => typeof window.nya), "object");
  });

  test("opens on the pane that was requested, not the default one", async () => {
    assert.equal(await panel.$eval(".tab.active", (el) => el.textContent), "Network");
  });
});

describe("profiles", () => {
  test("creates a profile on another release channel", async () => {
    const id = await panel.evaluate(() =>
      window.nya.createProfile({ name: "E2E Canary", channel: "canary", ephemeral: false }),
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
      window.nya.createProfile({ name: "Doomed", channel: "ptb", ephemeral: false }),
    );
    assert.ok(id);
    await until(async () => (await state()).profiles.some((profile) => profile.id === id));

    assert.equal(await panel.evaluate((target) => window.nya.deleteProfile(target), id), true);
    await until(async () => !(await state()).profiles.some((profile) => profile.id === id));
  });

  test("keeps at least one profile so there is never a dead end", async () => {
    assert.ok((await state()).profiles.length >= 1);
  });
});

describe("privacy policy", () => {
  test("applies a preset", async () => {
    await panel.evaluate(() => window.nya.applyPreset("paranoid"));
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
    const stored = await panel.evaluate((value) => window.nya.setDns(value), dns);
    assert.deepEqual(stored, dns);
    assert.equal((await state()).policy.preset, "paranoid");
  });

  test("refuses secure DNS with no usable server instead of killing resolution", async () => {
    const stored = await panel.evaluate(() =>
      window.nya.setDns({ mode: "secure", servers: ["http://not-secure.example"] }),
    );
    assert.equal(stored.mode, "automatic");
  });
});

describe("appearance", () => {
  test("the pane opens and titles itself", async () => {
    await panel.click('.tab[data-pane="appearance"]');
    await until(async () => (await panel.$eval("#pane-title", (el) => el.textContent)) === "Appearance");
    assert.equal(await panel.$eval(".tab.active", (el) => el.textContent), "Appearance");
  });

  test("defaults to the unified layout and round-trips a change", async () => {
    assert.equal((await state()).appearance.layout, "unified");

    await panel.click(".layout-card:nth-child(2)");
    await until(async () => (await state()).appearance.layout === "classic");

    await panel.click(".layout-card:nth-child(1)");
    await until(async () => (await state()).appearance.layout === "unified");
  });

  test("remembers which side of the switcher is showing", async () => {
    const stored = await panel.evaluate(() =>
      window.nya.setAppearance({ layout: "unified", activeTab: "servers" }),
    );
    assert.equal(stored.activeTab, "servers");
    assert.equal((await state()).appearance.activeTab, "servers");
  });

  test("refuses a tab it does not know", async () => {
    const stored = await panel.evaluate(() =>
      window.nya.setAppearance({ layout: "unified", activeTab: "nonsense" } as never),
    );
    assert.equal(stored.activeTab, "dms");
  });
});

describe("switcher strip", () => {
  /** What the injected stylesheet reports about itself, read off the page. */
  function marker(name: string): Promise<string> {
    return app.evaluate(({ BaseWindow }, property) => {
      const view = (
        BaseWindow.getAllWindows()[0]?.contentView.children as unknown as MainView[]
      ).find((child) => !(child.webContents?.getURL() ?? "file://").startsWith("file://"));
      if (!view) throw new Error("no Discord view");
      return view.webContents.executeJavaScript(
        `getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(property)}).trim()`,
      ) as Promise<string>;
    }, name) as Promise<string>;
  }

  /** The strip's own page, which Playwright sees as another window. */
  function stripPage(): Promise<Page> {
    return until(() => app.windows().find((page) => page.url().includes("switcher.html")));
  }

  test("exists as a real view under the unified layout", async () => {
    await panel.evaluate(() => window.nya.setAppearance({ layout: "unified", activeTab: "dms" }));
    const strip = await stripPage();
    // Two pills, drawn from the same SIDEBAR_TABS the injection uses.
    assert.deepEqual(await strip.$$eval(".pill", (els) => els.map((el) => el.textContent)), [
      "DMs",
      "Servers",
    ]);
  });

  test("marks the side that is actually injected", async () => {
    const strip = await stripPage();
    assert.equal(await strip.$eval(".pill.on", (el) => el.textContent), "DMs");
    assert.equal(await marker("--nya-side"), "dms");
  });

  test("clicking a pill swaps the injected stylesheet", async () => {
    // The end-to-end path this whole feature rests on: a click in our own view,
    // over IPC, into config, out as a different user stylesheet on Discord's
    // page. Nothing of ours runs inside that page to make it happen.
    const strip = await stripPage();
    await strip.click(".pill:nth-child(2)");

    await until(async () => (await state()).appearance.activeTab === "servers");
    await until(async () => (await marker("--nya-side")) === "servers");
    assert.equal(await strip.$eval(".pill.on", (el) => el.textContent), "Servers");
  });

  test("reserves exactly as much room as the strip occupies", async () => {
    // Two numbers that must agree: the view's height and the padding the
    // stylesheet leaves for it. When they drift, the seam is visible.
    const height = await app.evaluate(({ BaseWindow }) => {
      const views = BaseWindow.getAllWindows()[0]?.contentView.children as unknown as {
        getBounds(): { height: number };
        webContents?: { getURL(): string };
      }[];
      const strip = views.find((view) => (view.webContents?.getURL() ?? "").includes("switcher.html"));
      return strip?.getBounds().height ?? 0;
    });

    assert.ok(height > 0);
    assert.equal(await marker("--nya-switcher-height"), `${height}px`);
  });

  test("goes away under the classic layout, along with the stylesheet", async () => {
    await panel.evaluate(() => window.nya.setAppearance({ layout: "classic", activeTab: "dms" }));

    await until(
      async () =>
        (await app.evaluate(({ BaseWindow }) => {
          const views = BaseWindow.getAllWindows()[0]?.contentView.children as unknown as {
            webContents?: { getURL(): string };
          }[];
          return views.every((view) => !(view.webContents?.getURL() ?? "").includes("switcher.html"));
        })) === true,
    );

    assert.equal(await marker("--nya-side"), "");
  });

  test("comes back when the unified layout does", async () => {
    await panel.evaluate(() => window.nya.setAppearance({ layout: "unified", activeTab: "dms" }));
    const strip = await stripPage();
    assert.equal(await strip.$eval(".pill.on", (el) => el.textContent), "DMs");
    assert.equal(await marker("--nya-side"), "dms");
  });
});

describe("request filtering", () => {
  test("blocks the analytics endpoint and records it", async () => {
    const error = await app
      .evaluate(({ BaseWindow }) => {
        const view = (
          BaseWindow.getAllWindows()[0]?.contentView.children as unknown as MainView[]
        ).find((child) => !(child.webContents?.getURL() ?? "file://").startsWith("file://"));
        if (!view) throw new Error("no Discord view");
        return view.webContents.loadURL("https://discord.com/api/v9/science");
      })
      .then(() => "")
      .catch((e: Error) => e.message);

    assert.match(error, /ERR_BLOCKED_BY_CLIENT/);

    const snapshot = await until(async () => {
      const ledger = await panel.evaluate(() => window.nya.getLedger());
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
      ([id, proxy]) => window.nya.setProfileProxy(id as string, proxy as ProxyConfig),
      [active.id, requested] as const,
    );
    assert.equal(stored?.mode, "manual");

    // Ask Chromium itself instead of trusting that we stored a setting.
    const resolved = await app.evaluate(({ BaseWindow }) => {
      const view = (
        BaseWindow.getAllWindows()[0]?.contentView.children as unknown as MainView[]
      ).find((child) => !(child.webContents?.getURL() ?? "file://").startsWith("file://"));
      if (!view) throw new Error("no Discord view");
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
        window.nya.setProfileProxy(id as string, {
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
