/**
 * Packaging smoke test.
 *
 * The suites in `test/e2e` run the app unpackaged, from a plain Electron binary
 * with no fuses flipped. That leaves a whole class of bug invisible, and one of
 * them shipped: with `GrantFileProtocolExtraPrivileges` off, Electron cannot
 * resolve a `file://` URL inside an asar, so every one of our UI pages failed
 * with ERR_FILE_NOT_FOUND in a packaged build and worked perfectly in
 * development.
 *
 * This test is the only thing that looks at the artifact a user would actually
 * run. It needs `npm run dist:dir` first and skips itself if that has not been
 * done, so it stays out of the way locally while still gating CI.
 *
 * Playwright's Electron launcher cannot drive a fused binary, because it needs
 * `ELECTRON_RUN_AS_NODE`, which is off. `--remote-debugging-port` is a Chromium
 * switch and not covered by `EnableNodeCliInspectArguments`, so CDP is the way
 * in.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser } from "playwright-core";

const DEBUG_PORT = 9333;

const BINARY = {
  linux: join("release", "linux-unpacked", "nyacord"),
  win32: join("release", "win-unpacked", "Nyacord.exe"),
  darwin: join("release", "mac", "Nyacord.app", "Contents", "MacOS", "Nyacord"),
}[process.platform as "linux" | "win32" | "darwin"];

const projectRoot = join(__dirname, "..", "..", "..");
const binary = BINARY ? join(projectRoot, BINARY) : "";
const packaged = binary !== "" && existsSync(binary);

let proc: ChildProcess | null = null;
let browser: Browser | null = null;
let dataDir = "";
let stderr = "";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  if (!packaged) return;
  dataDir = mkdtempSync(join(tmpdir(), "nya-pkg-"));

  proc = spawn(binary, [`--data-dir=${dataDir}`, `--remote-debugging-port=${DEBUG_PORT}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  // Chromium needs to be up before the debugging port answers.
  for (let attempt = 0; attempt < 40 && !browser; attempt += 1) {
    await wait(500);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
    } catch {
      // Not listening yet.
    }
  }
});

after(async () => {
  await browser?.close();
  proc?.kill("SIGKILL");
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe("packaged build", { skip: packaged ? false : "run `npm run dist:dir` first" }, () => {
  test("serves its own UI, which a fused file:// build cannot", async () => {
    assert.ok(browser, "could not attach to the packaged app over CDP");

    const pages = browser.contexts().flatMap((context) => context.pages());
    const strip = pages.find((page) => page.url() === "nya://ui/switcher.html");
    assert.ok(strip, `no switcher page; saw ${pages.map((p) => p.url()).join(", ")}`);

    const loaded = await strip.evaluate(() => ({
      body: document.body.innerHTML.length,
      // Proves the stylesheet resolved over the custom scheme too, not only
      // the document.
      rules: [...document.styleSheets].reduce((n, sheet) => {
        try {
          return n + sheet.cssRules.length;
        } catch {
          return n;
        }
      }, 0),
      bridge: typeof (window as unknown as { nyaSwitcher?: unknown }).nyaSwitcher,
    }));

    assert.ok(loaded.body > 0, "the page rendered nothing");
    assert.ok(loaded.rules > 0, "the stylesheet did not load");
    assert.equal(loaded.bridge, "object", "the preload did not attach");
  });

  test("loads every asset without a missing-file error", () => {
    // The original failure was exactly this line in stderr, on a build whose
    // asar contained the file all along.
    assert.equal(
      /ERR_FILE_NOT_FOUND/.test(stderr),
      false,
      `packaged app reported a missing file:\n${stderr.split("\n").filter((l) => l.includes("ERR_FILE_NOT_FOUND")).join("\n")}`,
    );
  });
});
