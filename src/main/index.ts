import { app, net, powerMonitor } from "electron";

import { openConfig } from "./config";
import { registerIpc } from "./ipc";
import { buildMenu } from "./menu";
import { initializePaths, pathDecision, dataRoot } from "./paths";
import { PrivacyLedger } from "./privacy/ledger";
import { ProfileStore } from "./profiles";
import { applyChromiumSwitches } from "./switches";
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

/**
 * Secure DNS is configured on the host resolver, which is process-wide — so
 * like the Chromium switches it follows the global policy, not a profile.
 * It must be set before the first resolution, hence immediately on ready.
 */
function configureDns(): void {
  const { dns } = config.get();
  try {
    app.configureHostResolver({
      secureDnsMode: dns.mode,
      secureDnsServers: dns.servers,
    });
  } catch (error) {
    console.error("[sable] failed to configure secure DNS:", error);
  }
}

app.whenReady().then(() => {
  configureDns();

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

  registerIpc(shell, config, profiles, ledger, configureDns);
  buildMenu(shell);

  tray = new AppTray(shell);
  tray.create();

  shell.start();

  // Keep the tray label in step with unread counts. `refresh` is a no-op
  // unless something actually changed, so this stays cheap.
  const refreshTray = setInterval(() => tray?.refresh(), 5_000);

  /**
   * Resuming from sleep and regaining connectivity are the two moments a
   * long-lived chat client most often comes back to a dead socket. Both nudge
   * the watchdogs rather than waiting for Discord's own retry.
   */
  powerMonitor.on("resume", () => shell?.onNetworkOnline());

  let wasOnline = net.isOnline();
  const netPoll = setInterval(() => {
    const online = net.isOnline();
    if (online && !wasOnline) shell?.onNetworkOnline();
    wasOnline = online;
  }, 10_000);
  netPoll.unref();

  app.on("activate", () => shell?.focus());

  app.on("before-quit", () => {
    clearInterval(refreshTray);
    clearInterval(netPoll);
    // Let the window actually close this time; it hides on close otherwise.
    shell?.releaseForQuit();
    config.flush();
    tray?.destroy();
  });
});

/**
 * Closing the window hides it rather than destroying it, so this only fires
 * during a real quit. It stays as a safety net for the case where the tray
 * icon failed to load: without a tray there is no way back to a hidden
 * window, so on those platforms the app should genuinely exit.
 */
app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !tray?.isActive()) app.quit();
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
