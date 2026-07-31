import { BaseWindow, WebContentsView, dialog, nativeTheme, type Rectangle } from "electron";
import { join } from "node:path";

import { CHANNELS } from "../common/channels";
import { IPC, type AppState, type PaneId } from "../common/ipc";
import type { PermissionKey } from "../common/policy";
import { parseBadgeFromTitle, type Profile, type ProfileSummary } from "../common/profile";
import type { NyacordConfig } from "./config";
import type { ProfileStore } from "./profiles";
import type { PrivacyLedger } from "./privacy/ledger";
import { ViewWatchdog } from "./reliability/watchdog";
import { normalizeProxy, type ProxyConfig } from "../common/network";
import { containNavigation, freezeNavigation } from "./security/navigation";
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
}

/** Facts about the running build that never change once the app has started. */
export interface RuntimeInfo {
  readonly version: string;
  readonly electron: string;
  readonly chrome: string;
  readonly portable: boolean;
  readonly portableReason: string;
  readonly dataDir: string;
  readonly devMode: boolean;
}

export class AppShell {
  private readonly window: BaseWindow;
  private readonly views = new Map<string, ProfileView>();
  private shell: WebContentsView | null = null;
  private shellReady: Promise<void> = Promise.resolve();
  private panelOpen = false;
  private allowClose = false;

  constructor(
    private readonly config: JsonStore<NyacordConfig>,
    private readonly profiles: ProfileStore,
    private readonly ledger: PrivacyLedger,
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
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#111214" : "#ffffff",
      show: false,
    });

    if (bounds.maximized) this.window.maximize();

    this.window.on("resize", () => this.layout());
    this.window.on("maximize", () => this.layout());
    this.window.on("unmaximize", () => this.layout());
    /**
     * Close hides rather than destroys, the way every messenger behaves: the
     * gateway connection stays up so notifications keep arriving, and there is
     * still a window to re-show when the user clicks the tray or docks icon.
     *
     * Destroying it here was a bug on two counts — `activate` would try to
     * focus a destroyed window, and with no tray there was no route back.
     * Quitting is explicit, and `allowClose` is what makes it possible.
     */
    this.window.on("close", (event) => {
      this.persistBounds();
      if (this.allowClose) return;
      event.preventDefault();
      this.window.hide();
    });

    this.ledger.onChange(() => this.pushLedger());
  }

  /** Lets the real quit through; see the `close` handler above. */
  releaseForQuit(): void {
    this.allowClose = true;
  }

  start(): void {
    const active = this.profiles.active();
    if (active) this.showProfile(active.id);
    this.window.show();
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
    if (this.panelOpen && this.shell) {
      // Keep the panel on top of whatever was just swapped in.
      this.window.contentView.removeChildView(this.shell);
      this.window.contentView.addChildView(this.shell);
    }
    this.layout();
    this.window.setTitle(`${profile.name} — ${CHANNELS[profile.channel].label}`);
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
        // Deliberately no `preload`. Nothing of ours runs inside Discord's
        // page, so there is no bridge for a compromised renderer to abuse and
        // nothing that could be mistaken for client modification.
      },
    });

    view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#111214" : "#ffffff");
    containNavigation(view.webContents, channel);

    const watchdog = new ViewWatchdog(view, channel.appUrl, {
      onDegraded: (cause) => console.warn(`[nyacord] ${profile.name}: ${cause}`),
    });

    const entry: ProfileView = { profile, view, watchdog, badge: -1 };

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
  }

  /**
   * Navigates the active profile to a channel path.
   *
   * This is how a folder entry actually opens a chat, and it needs nothing
   * inside Discord's page: the web app is a normal SPA whose routes are URLs,
   * so a folder is a set of destinations rather than a set of DOM handles. The
   * path is resolved against the profile's own channel, so the same folder
   * works on Stable, PTB and Canary.
   */
  openChat(path: string): boolean {
    const profile = this.profiles.active();
    if (!profile) return false;
    const entry = this.views.get(profile.id);
    if (!entry) return false;

    void entry.view.webContents.loadURL(`${CHANNELS[profile.channel].origin}${path}`);
    this.closePanel();
    return true;
  }

  reloadActive(): void {
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
   * promises both, so both have to happen — removing the config entry alone
   * would leave a logged-in session on disk under a partition nothing points
   * at any more.
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
   * connection re-established rather than a mix of old and new.
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
        partition: "nyacord-shell",
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

  // ----------------------------------------------------------------- layout

  private layout(): void {
    const area = this.contentBounds();
    for (const entry of this.views.values()) entry.view.setBounds(area);
    this.shell?.setBounds(area);
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
      profiles: this.summaries(),
      activeProfileId: this.profiles.activeId(),
    };
  }

  // ------------------------------------------------------------ permissions

  /**
   * "Ask" permissions surface as a native modal rather than a page-drawn one,
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
