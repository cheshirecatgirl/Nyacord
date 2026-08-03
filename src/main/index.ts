import { app, net, powerMonitor } from "electron";
import { join } from "node:path";

import { openConfig } from "./config";
import { registerIpc } from "./ipc";
import { buildMenu } from "./menu";
import { initializePaths, pathDecision, dataRoot } from "./paths";
import { LayoutStyles } from "./layout";
import { PrivacyLedger } from "./privacy/ledger";
import { ProfileStore } from "./profiles";
import { applyChromiumSwitches } from "./switches";
import { AppTray } from "./tray";
import { ProfileVault } from "./vault";
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
let vault: ProfileVault | null = null;
/** Guards the seal-then-exit dance in `before-quit` against re-entering itself. */
let sealing = false;

app.on("second-instance", () => shell?.focus());

/**
 * Secure DNS is configured on the host resolver, which is process-wide, so
 * like the Chromium switches it follows the global config, not a
 * profile. It has to be set before the first resolution.
 */
function configureDns(): void {
  const { dns } = config.get();
  try {
    app.configureHostResolver({
      secureDnsMode: dns.mode,
      secureDnsServers: dns.servers,
    });
  } catch (error) {
    console.error("[nya] failed to configure secure DNS:", error);
  }
}

app.whenReady().then(() => {
  configureDns();

  const ledger = new PrivacyLedger();
  const profiles = new ProfileStore(config);
  const decision = pathDecision();
  const layoutStyles = new LayoutStyles(
    join(__dirname, "..", "..", "..", "assets", "layout", "unified.css"),
  );

  /**
   * The vault wraps `session/Partitions`, which is where every profile's
   * cookies, localStorage, IndexedDB and cache live. It is constructed before
   * the shell and checked before any profile view exists, because creating one
   * is what makes Chromium open that directory.
   */
  vault = new ProfileVault(
    join(app.getPath("sessionData"), "Partitions"),
    join(dataRoot(), "vault.bin"),
    join(dataRoot(), "vault.json"),
  );
  vault.noteStartupState();

  shell = new AppShell(config, profiles, ledger, layoutStyles, vault, {
    version: app.getVersion(),
    electron: process.versions.electron ?? "unknown",
    chrome: process.versions.chrome ?? "unknown",
    portable: decision.portable,
    portableReason: decision.reason,
    dataDir: dataRoot(),
    layoutStylesheet: layoutStyles.path,
    devMode,
  });

  registerIpc(shell, config, profiles, ledger, vault, configureDns);
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
   * the watchdogs instead of waiting on Discord's own retry.
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

  app.on("before-quit", (event) => {
    if (sealing) return;

    clearInterval(refreshTray);
    clearInterval(netPoll);
    // Let the window actually close this time; it hides on close otherwise.
    shell?.releaseForQuit();
    layoutStyles.dispose();
    config.flush();
    tray?.destroy();

    /**
     * Sealing is the one thing at shutdown that cannot be synchronous: it
     * streams the whole profile tree through a cipher. So quitting is held,
     * the profile views are torn down so Chromium stops writing underneath the
     * snapshot, and the exit happens once the ciphertext is on disk.
     *
     * If sealing fails the plaintext is left alone and the app
     * still exits. An unsealed profile is a privacy problem; a half-deleted one
     * is a lost account.
     */
    if (!vault?.open) return;

    event.preventDefault();
    sealing = true;
    shell?.prepareForSeal();

    void vault
      .seal()
      .catch((error: unknown) => {
        console.error("[nya] sealing failed; the profile was left readable:", error);
      })
      .finally(() => app.exit(0));
  });
});

/**
 * Closing the window hides it instead of destroying it, so this only fires
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
