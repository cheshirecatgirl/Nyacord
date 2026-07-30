import { BaseWindow, WebContentsView, dialog, nativeTheme, type Rectangle } from "electron";
import { join } from "node:path";

import { CHANNELS } from "../common/channels";
import { IPC, type AppState, type PaneId } from "../common/ipc";
import type { PermissionKey } from "../common/policy";
import type { Profile, ProfileSummary } from "../common/profile";
import type { SableConfig } from "./config";
import type { ProfileStore } from "./profiles";
import type { PrivacyLedger } from "./privacy/ledger";
import { ViewWatchdog } from "./reliability/watchdog";
import { containNavigation, freezeNavigation } from "./security/navigation";
import { configureSession } from "./security/session";
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
  private panelOpen = false;

  constructor(
    private readonly config: JsonStore<SableConfig>,
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
      title: "Sable",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#111214" : "#ffffff",
      show: false,
    });

    if (bounds.maximized) this.window.maximize();

    this.window.on("resize", () => this.layout());
    this.window.on("maximize", () => this.layout());
    this.window.on("unmaximize", () => this.layout());
    this.window.on("close", () => this.persistBounds());

    this.ledger.onChange(() => this.pushLedger());
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
      onDegraded: (cause) => console.warn(`[sable] ${profile.name}: ${cause}`),
    });

    const entry: ProfileView = { profile, view, watchdog, badge: -1 };

    // Discord writes the unread count into the document title. Reading it is
    // free and needs no script injection.
    view.webContents.on("page-title-updated", (_event, title) => {
      entry.badge = parseBadge(title);
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

  reloadActive(): void {
    const id = this.profiles.activeId();
    if (id) this.views.get(id)?.watchdog.reload();
  }

  onNetworkOnline(): void {
    for (const entry of this.views.values()) entry.watchdog.onNetworkOnline();
  }

  /** Wipes storage for a profile without deleting the profile itself. */
  async clearProfileData(id: string): Promise<void> {
    const entry = this.views.get(id);
    const ses = entry?.view.webContents.session;
    this.closeProfileView(id);
    if (ses) {
      await ses.clearStorageData();
      await ses.clearCache();
      await ses.clearAuthCache();
    }
    if (this.profiles.activeId() === id) this.showProfile(id);
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
    this.pushState();
    shell.webContents.send(IPC.showPane, pane);
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
        partition: "sable-shell",
      },
    });

    // Transparent so the Discord view stays visible behind the panel.
    view.setBackgroundColor("#00000000");
    freezeNavigation(view.webContents);
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

/** Discord titles look like `(3) #general | Server`. */
export function parseBadge(title: string): number {
  const match = /^\((\d+)\)/.exec(title.trim());
  if (!match?.[1]) return 0;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : 0;
}
