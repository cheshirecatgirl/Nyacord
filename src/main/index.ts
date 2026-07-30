import { app, net, powerMonitor } from "electron";

import { openConfig } from "./config";
import { registerIpc } from "./ipc";
import { buildMenu } from "./menu";
import { initializePaths, pathDecision, dataRoot } from "./paths";
import { PrivacyLedger } from "./privacy/ledger";
import { ProfileStore } from "./profiles";
import { applyChromiumSwitches, disableCrashUploads } from "./switches";
import { AppTray } from "./tray";
import { AppShell } from "./window";

/**
 * Startup order matters and is not arbitrary:
 *
 *  1. Resolve the data directory, because Chromium captures its paths early.
 *  2. Read the config, because the policy drives command-line switches.
 *  3. Apply switches, because they must precede `app.whenReady()`.
 *  4. Only then build any windows.
 *
 * Getting this wrong is the classic way an Electron app ends up writing to
 * `~/.config` while claiming to be portable.
 */

const devMode = process.argv.includes("--dev") && !app.isPackaged;

initializePaths();
const config = openConfig();
applyChromiumSwitches(config.get().policy);
disableCrashUploads();

/**
 * The single-instance lock is keyed on the user-data directory, which means
 * two portable copies in two different folders run side by side while a second
 * launch of the same copy just focuses the window you already have.
 */
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

let shell: AppShell | null = null;
let tray: AppTray | null = null;

app.on("second-instance", () => shell?.focus());

app.whenReady().then(() => {
  const ledger = new PrivacyLedger();
  const profiles = new ProfileStore(config);
  const decision = pathDecision();

  shell = new AppShell(config, profiles, ledger, {
    version: app.getVersion(),
    electron: process.versions.electron ?? "unknown",
    chrome: process.versions.chrome ?? "unknown",
    portable: decision.portable,
    portableReason: decision.reason,
    dataDir: dataRoot(),
    devMode,
  });

  registerIpc(shell, config, profiles, ledger);
  buildMenu(shell);

  tray = new AppTray(shell);
  tray.create();

  shell.start();

  // Keep the tray label in step with unread counts without polling the views.
  const refreshTray = setInterval(() => tray?.refresh(), 5_000);
  app.on("before-quit", () => clearInterval(refreshTray));

  /**
   * Resuming from sleep and regaining connectivity are the two moments a
   * long-lived chat client most often comes back to a dead socket. Both nudge
   * the watchdogs rather than waiting for Discord's own retry.
   */
  powerMonitor.on("resume", () => shell?.onNetworkOnline());
  if (typeof net.isOnline === "function") {
    let wasOnline = net.isOnline();
    setInterval(() => {
      const online = net.isOnline();
      if (online && !wasOnline) shell?.onNetworkOnline();
      wasOnline = online;
    }, 10_000).unref();
  }

  app.on("activate", () => shell?.focus());
});

/**
 * Closing the last window does not quit: this is a messenger, and quitting
 * silently drops your notifications. Quit is explicit, via the menu or tray.
 */
app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !tray) app.quit();
});

app.on("before-quit", () => {
  config.flush();
  tray?.destroy();
});

/**
 * Refuse any renderer that somehow asks to be created with dangerous
 * preferences. Belt and braces on top of the per-view settings, and the thing
 * that catches a future code path someone adds without reading window.ts.
 */
app.on("web-contents-created", (_event, contents) => {
  contents.on("select-bluetooth-device", (event, _devices, callback) => {
    event.preventDefault();
    callback("");
  });
  if (!devMode) {
    contents.on("devtools-opened", () => contents.closeDevTools());
  }
});
