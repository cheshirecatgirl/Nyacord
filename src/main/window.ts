import {
  BaseWindow,
  WebContentsView,
  dialog,
  nativeTheme,
  powerMonitor,
  type Rectangle,
} from "electron";
import { join } from "node:path";

import {
  SWITCHER_HEIGHT,
  SWITCHER_WIDTH,
  contextFromUrl,
  tabForContext,
  type SidebarTabId,
} from "../common/appearance";
import { CHANNELS } from "../common/channels";
import {
  IPC,
  type AppState,
  type PaneId,
  type SwitcherState,
  type UnlockOutcome,
  type VaultState,
} from "../common/ipc";
import { lockoutMs } from "../common/passphrase";
import type { ProfileVault } from "./vault";
import type { PermissionKey } from "../common/policy";
import { parseBadgeFromTitle, type Profile, type ProfileSummary } from "../common/profile";
import type { NyaConfig } from "./config";
import type { ProfileStore } from "./profiles";
import type { PrivacyLedger } from "./privacy/ledger";
import { ViewWatchdog } from "./reliability/watchdog";
import { normalizeProxy, type ProxyConfig } from "../common/network";
import { containNavigation, freezeNavigation } from "./security/navigation";
import type { LayoutStyles } from "./layout";
import { applyProxy, configureSession, wipeSessionData } from "./security/session";
import type { JsonStore } from "./store";

/**
 * Web preferences shared by every renderer we create.
 *
 * These are the settings that matter. `sandbox` and `contextIsolation` are the
 * two that turn a renderer compromise from "arbitrary code on your machine"
 * into "arbitrary code in a sandbox with no Node".
 */
const HARDENED_PREFS = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  navigateOnDragDrop: false,
  /**
   * Discord is a background app by nature: throttling its renderer breaks
   * notification delivery and voice keepalives when the window is not focused.
   */
  backgroundThrottling: false,
} as const;

interface ProfileView {
  readonly profile: Profile;
  readonly view: WebContentsView;
  readonly watchdog: ViewWatchdog;
  badge: number;
  /** Handle for the injected layout stylesheet, so it can be swapped out. */
  cssKey: string | null;
}

/**
 * Painted behind a view until its page has content. Follows the OS theme, so
 * a dark desktop does not get a white flash while Discord loads.
 */
function chromeBackground(): string {
  return nativeTheme.shouldUseDarkColors ? "#111214" : "#ffffff";
}

/** Facts about the running build that never change once the app has started. */
export interface RuntimeInfo {
  readonly version: string;
  readonly electron: string;
  readonly chrome: string;
  readonly portable: boolean;
  readonly portableReason: string;
  readonly dataDir: string;
  /** Where the editable unified-layout stylesheet lives. */
  readonly layoutStylesheet: string;
  readonly devMode: boolean;
}

export class AppShell {
  private readonly window: BaseWindow;
  private readonly views = new Map<string, ProfileView>();
  private shell: WebContentsView | null = null;
  private shellReady: Promise<void> = Promise.resolve();
  private panelOpen = false;
  private switcher: WebContentsView | null = null;
  private switcherShown = false;
  private lock: WebContentsView | null = null;
  private lockShown = false;
  private lastUnlockAt = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private allowClose = false;

  constructor(
    private readonly config: JsonStore<NyaConfig>,
    private readonly profiles: ProfileStore,
    private readonly ledger: PrivacyLedger,
    private readonly layoutStyles: LayoutStyles,
    private readonly vault: ProfileVault,
    private readonly info: RuntimeInfo,
  ) {
    const bounds = this.config.get().window;
    this.window = new BaseWindow({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      minWidth: 480,
      minHeight: 360,
      title: "Nyacord",
      backgroundColor: chromeBackground(),
      show: false,
    });

    if (bounds.maximized) this.window.maximize();

    this.window.on("resize", () => this.layout());
    this.window.on("maximize", () => this.layout());
    this.window.on("unmaximize", () => this.layout());
    /**
     * Close hides instead of destroying, the way every messenger behaves: the
     * gateway connection stays up so notifications keep arriving, and there is
     * still a window to re-show when the user clicks the tray or docks icon.
     *
     * Destroying it here was a bug twice over: `activate` would focus a
     * destroyed window, and with no tray there was no route back. Quitting is
     * explicit, and `allowClose` is what lets it through.
     */
    this.window.on("close", (event) => {
      this.persistBounds();
      if (this.allowClose) return;
      event.preventDefault();
      this.window.hide();
    });

    // The background was sampled once at construction, so switching the OS to
    // dark mode left the window painting white behind every view until each
    // page repainted.
    nativeTheme.on("updated", () => this.applyTheme());

    this.ledger.onChange(() => this.pushLedger());

    // Editing the stylesheet should show up without a restart.
    this.layoutStyles.onChange(() => this.applyLayout());
  }

  /**
   * Puts the unified layout's stylesheet on every profile view, or takes it
   * off under Classic.
   *
   * Switching sides cannot set a class on Discord's page without running
   * script in it, so each side is a different stylesheet and the previous one
   * is removed. This is a user stylesheet, the same thing a browser extension
   * applies; nothing is executed.
   */
  applyLayout(): void {
    for (const entry of this.views.values()) void this.applyLayoutTo(entry);
    this.syncSwitcher();
  }

  private async applyLayoutTo(entry: ProfileView): Promise<void> {
    const contents = entry.view.webContents;
    if (contents.isDestroyed()) return;

    if (entry.cssKey) {
      try {
        await contents.removeInsertedCSS(entry.cssKey);
      } catch {
        // The key goes stale after a full page load; inserting again is enough.
      }
      entry.cssKey = null;
    }

    const { layout, activeTab } = this.config.get().appearance;
    if (layout !== "unified") return;

    const css = this.layoutStyles.css(activeTab);
    if (!css) return;

    try {
      entry.cssKey = await contents.insertCSS(css);
    } catch (error) {
      console.error("[nya] could not apply the layout stylesheet:", error);
    }
  }

  private applyTheme(): void {
    if (this.window.isDestroyed()) return;
    const background = chromeBackground();
    this.window.setBackgroundColor(background);
    for (const entry of this.views.values()) entry.view.setBackgroundColor(background);
    // The strip paints on Discord's background, not its own, so the OS
    // theme is the only hint it has about what is behind it.
    this.pushSwitcher();
  }

  /** Lets the real quit through; see the `close` handler above. */
  releaseForQuit(): void {
    this.allowClose = true;
  }

  /**
   * Tears down every profile view so the vault snapshots something that is not
   * being written as it is read.
   *
   * The files are not closed by this; Electron cannot destroy a session, so
   * Chromium keeps its handles until the process ends. It stops new writes,
   * which is the difference between sealing a profile and sealing one
   * mid-transaction.
   */
  prepareForSeal(): void {
    this.stopIdleTimer();
    for (const id of [...this.views.keys()]) this.closeProfileView(id);
  }

  /**
   * Brings the app up, behind the lock screen if there is a vault.
   *
   * No profile view is created while locked. A `WebContentsView` on a
   * `persist:` partition makes Chromium open that partition's directory, and
   * the directory should not exist in readable form until a passphrase has
   * been given.
   */
  start(): void {
    if (this.vault.enabled && !this.vault.open) {
      this.showLock();
      this.window.show();
      return;
    }
    this.startProfiles();
    this.window.show();
  }

  private startProfiles(): void {
    const active = this.profiles.active();
    if (active) this.showProfile(active.id);
    this.armIdleTimer();
  }

  // -------------------------------------------------------------------- lock

  vaultState(): VaultState {
    return {
      enabled: this.vault.enabled,
      open: this.vault.open,
      sealed: this.vault.sealedOnDisk,
      failures: this.vault.failures,
      retryInMs: this.retryInMs(),
      autoLockMinutes: this.vault.autoLockMinutes,
      leftUnsealed: this.vault.leftUnsealed,
    };
  }

  /**
   * How long the running app refuses another attempt. A courtesy to someone
   * who mistyped, not a defence; anyone holding the sealed file guesses
   * against their own hardware, which the KDF cost is what answers.
   */
  private retryInMs(): number {
    const wait = lockoutMs(this.vault.failures);
    if (wait === 0) return 0;
    return Math.max(0, this.lastUnlockAt + wait - Date.now());
  }

  async unlock(passphrase: string): Promise<UnlockOutcome> {
    const wait = this.retryInMs();
    if (wait > 0) return { ok: false, reason: "locked-out", retryInMs: wait };

    this.lastUnlockAt = Date.now();
    const result = await this.vault.unlock(passphrase);

    if (!result.ok) {
      this.pushVault();
      return { ok: false, reason: result.reason, retryInMs: this.retryInMs() };
    }

    this.hideLock();
    // Profiles may already exist if this was a re-lock, not a cold start.
    if (this.views.size === 0) this.startProfiles();
    else this.armIdleTimer();

    this.pushVault();
    this.pushState();
    return { ok: true };
  }

  /**
   * Re-locks a running app: the key is dropped and the screen goes up. The
   * files are not re-sealed, since Chromium still has them open; that waits
   * for quit, and docs/SECURITY.md says so instead of letting the padlock
   * imply more.
   *
   * Views stay alive, so the gateway connection survives and notifications
   * keep arriving behind the lock.
   */
  lockNow(): boolean {
    if (!this.vault.enabled) return false;
    this.closePanel();
    this.vault.forgetKey();
    this.showLock();
    this.pushVault();
    return true;
  }

  get locked(): boolean {
    return this.lockShown;
  }

  private showLock(): void {
    const view = this.ensureLock();
    if (!this.lockShown) {
      this.window.contentView.addChildView(view);
      this.lockShown = true;
      this.layout();
    }
    view.webContents.focus();
    this.stopIdleTimer();
    this.pushVault();
  }

  private hideLock(): void {
    if (!this.lockShown || !this.lock) return;
    this.window.contentView.removeChildView(this.lock);
    this.lockShown = false;
  }

  private ensureLock(): WebContentsView {
    if (this.lock) return this.lock;

    const view = new WebContentsView({
      webPreferences: {
        ...HARDENED_PREFS,
        preload: join(__dirname, "..", "preload", "lock.js"),
        partition: "nya-shell",
      },
    });

    // Opaque, unlike the settings panel. Nothing behind it should be legible.
    view.setBackgroundColor(chromeBackground());
    freezeNavigation(view.webContents);
    view.webContents.on("did-finish-load", () => this.pushVault());
    void view.webContents.loadFile(join(__dirname, "..", "renderer", "lock.html"));

    this.lock = view;
    return view;
  }

  pushVault(): void {
    const payload = this.vaultState();
    if (this.lock && !this.lock.webContents.isDestroyed()) {
      this.lock.webContents.send(IPC.vaultChanged, payload);
    }
    if (this.shell && !this.shell.webContents.isDestroyed()) {
      this.shell.webContents.send(IPC.vaultChanged, payload);
    }
  }

  /**
   * Auto-lock reads the OS idle time. Discord's page has no preload to report
   * activity from, and asking the system how long the keyboard and mouse have
   * been quiet is more accurate than inferring it anyway.
   */
  private armIdleTimer(): void {
    this.stopIdleTimer();
    if (!this.vault.enabled || this.vault.autoLockMinutes <= 0) return;

    const limit = this.vault.autoLockMinutes * 60;
    this.idleTimer = setInterval(() => {
      if (this.lockShown || !this.vault.open) return;
      if (powerMonitor.getSystemIdleTime() >= limit) this.lockNow();
    }, 15_000);
    this.idleTimer.unref();
  }

  private stopIdleTimer(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  /** Re-reads the auto-lock setting after it has been changed in Settings. */
  refreshIdleTimer(): void {
    if (this.vault.open) this.armIdleTimer();
  }

  get baseWindow(): BaseWindow {
    return this.window;
  }

  focus(): void {
    if (this.window.isDestroyed()) return;
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
  }

  // ---------------------------------------------------------------- profiles

  showProfile(id: string): void {
    const profile = this.profiles.find(id);
    if (!profile) return;

    this.profiles.setActive(id);
    const entry = this.views.get(id) ?? this.createProfileView(profile);

    for (const [otherId, other] of this.views) {
      if (otherId === id) continue;
      this.window.contentView.removeChildView(other.view);
    }

    this.window.contentView.addChildView(entry.view);
    this.syncSwitcher();
    this.raiseOverlays();
    this.layout();
    this.window.setTitle(`${profile.name} · ${CHANNELS[profile.channel].label}`);
    this.pushState();
  }

  private createProfileView(profile: Profile): ProfileView {
    const channel = CHANNELS[profile.channel];
    const policy = () => this.profiles.policyFor(profile.id);

    const ses = configureSession(this.profiles.partition(profile.id), {
      profileId: profile.id,
      channel,
      getPolicy: policy,
      ledger: this.ledger,
      prompt: (permission, origin) => this.askPermission(permission, origin, profile),
      proxy: this.profiles.proxyFor(profile.id),
    });

    const view = new WebContentsView({
      webPreferences: {
        ...HARDENED_PREFS,
        session: ses,
        spellcheck: policy().spellcheck,
        // No `preload`, and that is the point. Nothing of ours runs inside Discord's
        // page, so there is no bridge for a compromised renderer to abuse and
        // nothing that could be mistaken for client modification.
      },
    });

    view.setBackgroundColor(chromeBackground());
    containNavigation(view.webContents, channel);

    const watchdog = new ViewWatchdog(view, channel.appUrl, {
      onDegraded: (cause) => console.warn(`[nya] ${profile.name}: ${cause}`),
    });

    const entry: ProfileView = { profile, view, watchdog, badge: -1, cssKey: null };

    // Inserted CSS does not survive a full page load, so it goes back on every
    // time the document is replaced. SPA route changes keep it.
    view.webContents.on("did-finish-load", () => {
      entry.cssKey = null;
      void this.applyLayoutTo(entry);
    });

    /**
     * The strip follows navigation, so opening a DM from a notification moves
     * it to the DMs side instead of leaving a hidden list selected.
     *
     * Only the URL is read. `/channels/@me/…` and `/channels/<id>/…` already
     * say which side you are on, with nothing of ours in the page.
     */
    const follow = (url: string): void => {
      if (this.profiles.activeId() !== profile.id) return;
      const tab = tabForContext(contextFromUrl(url));
      if (tab) this.setActiveTab(tab);
    };
    view.webContents.on("did-navigate", (_event, url) => follow(url));
    view.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (isMainFrame) follow(url);
    });

    // Discord writes the unread count into the document title. Reading it is
    // free and needs no script injection.
    view.webContents.on("page-title-updated", (_event, title) => {
      entry.badge = parseBadgeFromTitle(title);
      this.pushState();
    });

    if (profile.userCss) {
      view.webContents.on("dom-ready", () => {
        void view.webContents.insertCSS(profile.userCss ?? "");
      });
    }

    void view.webContents.loadURL(channel.appUrl);
    this.views.set(profile.id, entry);
    return entry;
  }

  closeProfileView(id: string): void {
    const entry = this.views.get(id);
    if (!entry) return;
    this.window.contentView.removeChildView(entry.view);
    entry.watchdog.dispose();
    entry.view.webContents.close();
    this.views.delete(id);
    this.syncSwitcher();
  }

  reloadActive(): void {
    if (this.lockShown) return;
    const id = this.profiles.activeId();
    if (id) this.views.get(id)?.watchdog.reload();
  }

  onNetworkOnline(): void {
    for (const entry of this.views.values()) entry.watchdog.onNetworkOnline();
  }

  /** Wipes storage for a profile without deleting the profile itself. */
  async clearProfileData(id: string): Promise<void> {
    if (!this.profiles.find(id)) return;
    const partition = this.profiles.partition(id);
    this.closeProfileView(id);
    await wipeSessionData(partition);
    if (this.profiles.activeId() === id) this.showProfile(id);
  }

  /**
   * Deletes a profile *and* its stored session. The confirmation the user sees
   * promises both, so both have to happen. Removing the config entry alone
   * leaves a logged-in session on disk under a partition nothing points at.
   */
  async deleteProfile(id: string): Promise<void> {
    if (!this.profiles.find(id)) return;
    const partition = this.profiles.partition(id);
    this.closeProfileView(id);
    await wipeSessionData(partition);
    this.profiles.remove(id);
    const next = this.profiles.activeId();
    if (next) this.showProfile(next);
    this.pushState();
  }

  /**
   * Applies a proxy to a live session and reloads the view, because a change
   * of egress mid-session is exactly the moment the user wants every
   * connection re-established, not a mix of old and new.
   */
  async setProfileProxy(id: string, input: unknown): Promise<ProxyConfig> {
    const proxy = this.profiles.setProxy(id, input);
    const entry = this.views.get(id);
    if (entry) {
      await applyProxy(entry.view.webContents.session, proxy);
      entry.watchdog.reload();
    }
    this.pushState();
    return proxy;
  }

  summaries(): ProfileSummary[] {
    const activeId = this.profiles.activeId();
    return this.profiles.all().map((profile) => ({
      id: profile.id,
      name: profile.name,
      channel: profile.channel,
      ephemeral: profile.ephemeral,
      active: profile.id === activeId,
      badge: this.views.get(profile.id)?.badge ?? -1,
      proxy: normalizeProxy(profile.proxy),
    }));
  }

  totalBadge(): number {
    let total = 0;
    for (const entry of this.views.values()) if (entry.badge > 0) total += entry.badge;
    return total;
  }

  // ------------------------------------------------------------------ panel

  togglePanel(pane: PaneId = "profiles"): void {
    if (this.panelOpen) this.closePanel();
    else this.openPanel(pane);
  }

  openPanel(pane: PaneId = "profiles"): void {
    // Menu items and their accelerators stay live while locked, so this is the
    // gate that stops Ctrl+P putting a profile list over the lock screen.
    if (this.lockShown) return;
    const shell = this.ensureShell();
    if (!this.panelOpen) {
      this.window.contentView.addChildView(shell);
      this.panelOpen = true;
      this.layout();
    }
    shell.webContents.focus();

    // The very first open creates the view and starts loading it, so the
    // renderer may not have registered its listeners yet. Sending immediately
    // drops the message and the panel opens on the wrong pane.
    void this.shellReady.then(() => {
      if (shell.webContents.isDestroyed()) return;
      this.pushState();
      shell.webContents.send(IPC.showPane, pane);
    });
  }

  closePanel(): void {
    if (!this.panelOpen || !this.shell) return;
    this.window.contentView.removeChildView(this.shell);
    this.panelOpen = false;
    const activeId = this.profiles.activeId();
    if (activeId) this.views.get(activeId)?.view.webContents.focus();
  }

  private ensureShell(): WebContentsView {
    if (this.shell) return this.shell;

    const view = new WebContentsView({
      webPreferences: {
        ...HARDENED_PREFS,
        preload: join(__dirname, "..", "preload", "shell.js"),
        // The panel is our own local UI; it never loads remote content, so it
        // gets a dedicated in-memory partition with no cookies at all.
        partition: "nya-shell",
      },
    });

    // Transparent so the Discord view stays visible behind the panel.
    view.setBackgroundColor("#00000000");
    freezeNavigation(view.webContents);
    this.shellReady = new Promise<void>((resolve) => {
      view.webContents.once("did-finish-load", () => resolve());
      view.webContents.once("did-fail-load", () => resolve());
    });
    void view.webContents.loadFile(join(__dirname, "..", "renderer", "shell.html"));
    this.shell = view;
    return view;
  }

  // -------------------------------------------------------------- switcher

  /**
   * Changes which side of the switcher is showing. The only write path for the
   * active tab, so the strip, the settings panel and navigation converge here
   * and cannot disagree.
   */
  setActiveTab(tab: SidebarTabId, restoreFocus = false): void {
    if (this.config.get().appearance.activeTab !== tab) {
      this.config.update((draft) => {
        draft.appearance.activeTab = tab;
      });
      this.applyLayout();
      this.pushState();
    }
    // Clicking the strip focuses it, which would silently stop the message box
    // receiving keystrokes. Keyboard selection asks not to, so arrow keys can
    // keep moving along the strip.
    if (restoreFocus) this.focusActiveProfile();
  }

  private focusActiveProfile(): void {
    if (this.panelOpen) return;
    const id = this.profiles.activeId();
    const entry = id ? this.views.get(id) : undefined;
    if (entry && !entry.view.webContents.isDestroyed()) entry.view.webContents.focus();
  }

  /**
   * Attaches or detaches the strip to match the current layout: only under
   * Unified, only with a Discord view to sit over, and only while the
   * stylesheet is reserving room for it. That last one keeps emptying the
   * stylesheet a clean way back to plain Discord, instead of leaving a strip
   * floating over a server rail that never moved aside.
   */
  private syncSwitcher(): void {
    const wanted =
      this.config.get().appearance.layout === "unified" &&
      this.views.size > 0 &&
      !this.layoutStyles.isEmpty;

    if (!wanted) {
      if (this.switcherShown && this.switcher) {
        this.window.contentView.removeChildView(this.switcher);
        this.switcherShown = false;
      }
      return;
    }

    const view = this.ensureSwitcher();
    if (!this.switcherShown) {
      this.window.contentView.addChildView(view);
      this.switcherShown = true;
      this.raiseOverlays();
      this.layout();
    }
    this.pushSwitcher();
  }

  private ensureSwitcher(): WebContentsView {
    if (this.switcher) return this.switcher;

    const view = new WebContentsView({
      webPreferences: {
        ...HARDENED_PREFS,
        preload: join(__dirname, "..", "preload", "switcher.js"),
        // Shares the panel's cookie-less in-memory partition. Both are local
        // file:// UI of ours; neither ever loads anything remote.
        partition: "nya-shell",
      },
    });

    // Transparent, so the strip sits on Discord's own sidebar colour and needs
    // to be told nothing about which theme is in use.
    view.setBackgroundColor("#00000000");
    freezeNavigation(view.webContents);
    view.webContents.on("did-finish-load", () => this.pushSwitcher());
    void view.webContents.loadFile(join(__dirname, "..", "renderer", "switcher.html"));

    this.switcher = view;
    return view;
  }

  private pushSwitcher(): void {
    if (!this.switcher || this.switcher.webContents.isDestroyed()) return;
    const payload: SwitcherState = {
      activeTab: this.config.get().appearance.activeTab,
      dark: nativeTheme.shouldUseDarkColors,
    };
    this.switcher.webContents.send(IPC.switcherState, payload);
  }

  // ----------------------------------------------------------------- layout

  /**
   * Puts the overlays back on top after a view is added underneath them.
   * `addChildView` moves an existing child to the front, so swapping profiles
   * would otherwise bury the strip and the panel.
   */
  private raiseOverlays(): void {
    if (this.switcherShown && this.switcher) {
      this.window.contentView.removeChildView(this.switcher);
      this.window.contentView.addChildView(this.switcher);
    }
    if (this.panelOpen && this.shell) {
      this.window.contentView.removeChildView(this.shell);
      this.window.contentView.addChildView(this.shell);
    }
    // The lock screen is last unconditionally. Everything else in this method
    // is a matter of taste; this one is the security property.
    if (this.lockShown && this.lock) {
      this.window.contentView.removeChildView(this.lock);
      this.window.contentView.addChildView(this.lock);
    }
  }

  private layout(): void {
    const area = this.contentBounds();
    for (const entry of this.views.values()) entry.view.setBounds(area);
    this.shell?.setBounds(area);
    this.lock?.setBounds(area);
    // Pinned to the top-left corner, over the sidebar. Clamped so a window
    // narrower than the sidebar does not get a strip hanging off the edge.
    this.switcher?.setBounds({
      x: 0,
      y: 0,
      width: Math.min(SWITCHER_WIDTH, area.width),
      height: Math.min(SWITCHER_HEIGHT, area.height),
    });
  }

  private contentBounds(): Rectangle {
    const { width, height } = this.window.getContentBounds();
    return { x: 0, y: 0, width, height };
  }

  private persistBounds(): void {
    const maximized = this.window.isMaximized();
    const bounds = maximized ? this.window.getNormalBounds() : this.window.getBounds();
    this.config.update((draft) => {
      draft.window = {
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        maximized,
      };
    });
    this.config.flush();
  }

  // -------------------------------------------------------------- messaging

  pushState(): void {
    this.shell?.webContents.send(IPC.stateChanged, this.state());
  }

  private pushLedger(): void {
    if (!this.panelOpen) return;
    this.shell?.webContents.send(IPC.ledgerChanged, this.ledger.snapshot());
  }

  state(): AppState {
    return {
      ...this.info,
      policy: this.config.get().policy,
      dns: this.config.get().dns,
      appearance: this.config.get().appearance,
      vault: this.vaultState(),
      profiles: this.summaries(),
      activeProfileId: this.profiles.activeId(),
    };
  }

  // ------------------------------------------------------------ permissions

  /**
   * "Ask" permissions surface as a native modal, not a page-drawn one,
   * so a compromised renderer cannot fake the dialog or click it for you.
   */
  private async askPermission(
    permission: PermissionKey,
    origin: string,
    profile: Profile,
  ): Promise<boolean> {
    const { response, checkboxChecked } = await dialog.showMessageBox(this.window, {
      type: "question",
      buttons: ["Deny", "Allow"],
      defaultId: 0,
      cancelId: 0,
      title: "Permission request",
      message: `Allow ${describe(permission)}?`,
      detail: `${origin} is requesting access in the profile "${profile.name}".`,
      checkboxLabel: "Remember this decision for this profile",
      checkboxChecked: false,
      noLink: true,
    });

    const allowed = response === 1;
    if (checkboxChecked) {
      this.config.update((draft) => {
        const target = draft.profiles.find((p) => p.id === profile.id);
        if (!target) return;
        target.policy ??= structuredClone(draft.policy);
        target.policy.permissions[permission] = allowed ? "allow" : "deny";
        target.policy.preset = "custom";
      });
      this.pushState();
    }
    return allowed;
  }
}

function describe(permission: PermissionKey): string {
  switch (permission) {
    case "media":
      return "camera and microphone access";
    case "display-capture":
      return "screen sharing";
    case "notifications":
      return "desktop notifications";
    case "openExternal":
      return "opening an external application";
    default:
      return `the "${permission}" capability`;
  }
}
