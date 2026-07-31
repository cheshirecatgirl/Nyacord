/**
 * Shell UI.
 *
 * Written as a plain script with no imports so it compiles to a single file
 * the CSP can serve as `script-src 'self'` with no bundler in the loop. All
 * DOM is built with `textContent` and `createElement`; there is no `innerHTML`
 * anywhere, so ledger entries — which contain URLs from the network — cannot
 * become markup.
 */
(() => {
  type PaneId = "profiles" | "privacy" | "network" | "inspector" | "about";

  interface ProxyConfig {
    mode: "system" | "direct" | "manual" | "pac";
    rules: string;
    pacUrl: string;
    bypass: string;
  }

  interface ProfileSummary {
    id: string;
    name: string;
    channel: "stable" | "ptb" | "canary";
    ephemeral: boolean;
    active: boolean;
    badge: number;
    proxy: ProxyConfig;
  }

  interface GhostPolicy {
    enabled: boolean;
    suppressTyping: boolean;
    suppressReadReceipts: boolean;
    suppressCallReports: boolean;
  }

  interface DnsConfig {
    mode: "off" | "automatic" | "secure";
    servers: string[];
  }

  interface Policy {
    preset: string;
    ghost: GhostPolicy;
    dns: DnsConfig;
    [key: string]: unknown;
  }

  interface AppState {
    version: string;
    electron: string;
    chrome: string;
    portable: boolean;
    portableReason: string;
    dataDir: string;
    policy: Policy;
    profiles: ProfileSummary[];
    activeProfileId: string | null;
    devMode: boolean;
  }

  interface LedgerEntry {
    at: number;
    profileId: string;
    category: string;
    reason: string;
    url: string;
    method: string;
  }

  interface LedgerSnapshot {
    totals: Record<string, number>;
    recent: LedgerEntry[];
    since: number;
  }

  interface SableApi {
    getState(): Promise<AppState>;
    setPolicy(policy: Policy): Promise<Policy>;
    applyPreset(name: string): Promise<Policy | null>;
    createProfile(request: {
      name: string;
      channel: string;
      ephemeral: boolean;
    }): Promise<string | null>;
    switchProfile(id: string): Promise<boolean>;
    renameProfile(id: string, name: string): Promise<boolean>;
    deleteProfile(id: string): Promise<boolean>;
    clearProfileData(id: string): Promise<boolean>;
    setProfileProxy(id: string, proxy: ProxyConfig): Promise<ProxyConfig | null>;
    getLedger(profileId?: string): Promise<LedgerSnapshot>;
    clearLedger(): Promise<boolean>;
    closePanel(): Promise<boolean>;
    reloadActive(): Promise<boolean>;
    openExternal(url: string): Promise<boolean>;
    onStateChanged(listener: (state: AppState) => void): void;
    onLedgerChanged(listener: (snapshot: LedgerSnapshot) => void): void;
    onShowPane(listener: (pane: PaneId) => void): void;
  }

  const sable = (window as unknown as { sable: SableApi }).sable;

  const CHANNEL_LABELS: Record<string, string> = {
    stable: "Stable",
    ptb: "PTB",
    canary: "Canary",
  };
  const CHANNEL_ACCENTS: Record<string, string> = {
    stable: "#5865f2",
    ptb: "#3ba55d",
    canary: "#faa61a",
  };
  const CATEGORY_LABELS: Record<string, string> = {
    telemetry: "Telemetry",
    "error-reporting": "Error reporting",
    "third-party-tracker": "Trackers",
    "browser-service": "Browser services",
    "ghost-typing": "Typing",
    "ghost-read-receipt": "Read receipts",
    "ghost-call-report": "Call reports",
    activity: "Activities",
    "third-party-media": "Off-platform media",
  };

  /**
   * The privacy pane is generated from this table rather than hand-written
   * markup so that adding a policy field cannot silently ship without a
   * user-facing explanation of what it does.
   */
  const TOGGLES: {
    group: string;
    key: string;
    ghost?: boolean;
    title: string;
    detail: string;
  }[] = [
    {
      group: "Tracking",
      key: "blockTelemetry",
      title: "Block Discord analytics",
      detail: "Drops requests to /api/science and friends.",
    },
    {
      group: "Tracking",
      key: "blockErrorReporting",
      title: "Block crash & error reporting",
      detail: "Stops Sentry uploads, which can include context about your session.",
    },
    {
      group: "Tracking",
      key: "blockThirdPartyTrackers",
      title: "Block third-party trackers",
      detail: "Known analytics hosts, blocked by name.",
    },
    {
      group: "Tracking",
      key: "blockBrowserServices",
      title: "Block browser background services",
      detail: "Chromium's own calls home: component updates, Safe Browsing, dictionaries.",
    },
    {
      group: "Ghost mode",
      key: "enabled",
      ghost: true,
      title: "Ghost mode",
      detail: "Master switch for the suppressions below.",
    },
    {
      group: "Ghost mode",
      key: "suppressTyping",
      ghost: true,
      title: "Never send typing indicators",
      detail: "Others will not see “… is typing” from you.",
    },
    {
      group: "Ghost mode",
      key: "suppressReadReceipts",
      ghost: true,
      title: "Never acknowledge reads",
      detail:
        "The server is not told you read a message. Unread badges may persist and will not sync to your phone.",
    },
    {
      group: "Ghost mode",
      key: "suppressCallReports",
      ghost: true,
      title: "Never upload call quality reports",
      detail: "Post-call voice/video telemetry.",
    },
    {
      group: "Exposure",
      key: "blockActivities",
      title: "Block embedded activities",
      detail: "Mini-apps served from discordsays.com run third-party code.",
    },
    {
      group: "Exposure",
      key: "blockThirdPartyMedia",
      title: "Block off-platform media",
      detail:
        "Link previews and embeds will not load from non-Discord hosts, so they cannot log your IP. Breaks some images.",
    },
    {
      group: "Fingerprinting",
      key: "sanitizeUserAgent",
      title: "Sanitize User-Agent",
      detail: "Removes the Electron and product tokens so requests look like stock Chromium.",
    },
    {
      group: "Fingerprinting",
      key: "normalizeClientHints",
      title: "Normalize client hints",
      detail: "Keeps Sec-CH-UA consistent with the sanitized User-Agent.",
    },
    {
      group: "Fingerprinting",
      key: "minimizeReferrer",
      title: "Minimize Referer",
      detail: "Send an origin for same-site requests and nothing cross-site.",
    },
    {
      group: "Fingerprinting",
      key: "globalPrivacyControl",
      title: "Send Global Privacy Control",
      detail: "Sec-GPC: 1 — a legally recognised opt-out signal in some jurisdictions.",
    },
    {
      group: "System",
      key: "spellcheck",
      title: "Spellchecker",
      detail: "Off by default because Chromium fetches dictionaries from Google on first use.",
    },
  ];

  const $ = <T extends HTMLElement>(selector: string): T =>
    document.querySelector(selector) as T;

  let state: AppState | null = null;

  // ------------------------------------------------------------------ panes

  function showPane(pane: PaneId): void {
    document.querySelectorAll<HTMLElement>(".pane").forEach((el) => {
      el.classList.toggle("hidden", el.dataset["pane"] !== pane);
    });
    document.querySelectorAll<HTMLElement>(".tab").forEach((el) => {
      el.classList.toggle("active", el.dataset["pane"] === pane);
    });
    if (pane === "inspector") void refreshLedger();
  }

  document.querySelectorAll<HTMLElement>(".tab").forEach((tab) => {
    tab.addEventListener("click", () => showPane(tab.dataset["pane"] as PaneId));
  });

  $("#close").addEventListener("click", () => void sable.closePanel());
  $("#backdrop").addEventListener("click", () => void sable.closePanel());
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") void sable.closePanel();
  });

  // --------------------------------------------------------------- profiles

  function renderProfiles(): void {
    const list = $("#profile-list");
    list.textContent = "";
    if (!state) return;

    for (const profile of state.profiles) {
      const li = document.createElement("li");
      if (profile.active) li.classList.add("active");

      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = CHANNEL_ACCENTS[profile.channel] ?? "#888";
      li.append(dot);

      const grow = document.createElement("div");
      grow.className = "grow";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = profile.name;
      const sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent =
        (CHANNEL_LABELS[profile.channel] ?? profile.channel) +
        (profile.ephemeral ? " · ephemeral" : "");
      grow.append(name, sub);
      li.append(grow);

      if (profile.badge > 0) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = String(profile.badge);
        li.append(badge);
      }

      if (!profile.active) {
        li.append(button("Open", () => void sable.switchProfile(profile.id)));
      }
      li.append(
        button("Rename", () => {
          const next = window.prompt("New name", profile.name);
          if (next) void sable.renameProfile(profile.id, next);
        }),
      );
      li.append(
        button("Sign out", () => {
          if (window.confirm(`Clear all stored data for "${profile.name}"?`)) {
            void sable.clearProfileData(profile.id);
          }
        }),
      );
      if (state.profiles.length > 1) {
        const remove = button("Delete", () => {
          if (window.confirm(`Delete the profile "${profile.name}" and its data?`)) {
            void sable.deleteProfile(profile.id);
          }
        });
        remove.classList.add("danger");
        li.append(remove);
      }

      list.append(li);
    }
  }

  function button(label: string, onClick: () => void): HTMLButtonElement {
    const el = document.createElement("button");
    el.textContent = label;
    el.addEventListener("click", onClick);
    return el;
  }

  $("#new-profile").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = ($("#new-name") as HTMLInputElement).value;
    const channel = ($("#new-channel") as HTMLSelectElement).value;
    const ephemeral = ($("#new-ephemeral") as HTMLInputElement).checked;
    void sable.createProfile({ name, channel, ephemeral }).then(() => {
      ($("#new-name") as HTMLInputElement).value = "";
      ($("#new-ephemeral") as HTMLInputElement).checked = false;
    });
  });

  // ---------------------------------------------------------------- privacy

  function renderPrivacy(): void {
    if (!state) return;
    const policy = state.policy;

    const presets = $("#presets");
    presets.textContent = "";
    for (const name of ["balanced", "strict", "paranoid"]) {
      const el = button(name[0]!.toUpperCase() + name.slice(1), () => {
        void sable.applyPreset(name);
      });
      if (policy.preset === name) el.classList.add("active");
      presets.append(el);
    }

    $("#preset-note").textContent =
      policy.preset === "custom"
        ? "Custom — you have changed individual settings."
        : "Pick a preset, or change anything below to go custom.";

    const container = $("#toggles");
    container.textContent = "";
    let lastGroup = "";

    for (const toggle of TOGGLES) {
      if (toggle.group !== lastGroup) {
        const heading = document.createElement("div");
        heading.className = "group-title";
        heading.textContent = toggle.group;
        container.append(heading);
        lastGroup = toggle.group;
      }

      const row = document.createElement("label");
      row.className = "toggle";

      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = toggle.ghost
        ? Boolean(policy.ghost[toggle.key as keyof GhostPolicy])
        : Boolean(policy[toggle.key]);

      // Sub-toggles are meaningless while the master switch is off; grey them
      // out rather than letting someone set a suppression that does nothing.
      if (toggle.ghost && toggle.key !== "enabled" && !policy.ghost.enabled) {
        input.disabled = true;
        row.style.opacity = "0.5";
      }

      input.addEventListener("change", () => {
        const next: Policy = { ...policy, ghost: { ...policy.ghost } };
        if (toggle.ghost) {
          (next.ghost as unknown as Record<string, boolean>)[toggle.key] = input.checked;
        } else {
          next[toggle.key] = input.checked;
        }
        void sable.setPolicy(next);
      });

      const grow = document.createElement("div");
      grow.className = "grow";
      const strong = document.createElement("strong");
      strong.textContent = toggle.title;
      const detail = document.createElement("span");
      detail.textContent = toggle.detail;
      grow.append(strong, detail);

      row.append(input, grow);
      container.append(row);
    }
  }

  // ---------------------------------------------------------------- network

  function activeProfile(): ProfileSummary | undefined {
    return state?.profiles.find((p) => p.active);
  }

  function renderNetwork(): void {
    if (!state) return;
    const profile = activeProfile();
    $("#proxy-profile").textContent = profile ? profile.name : "no profile";

    const proxy = profile?.proxy ?? { mode: "system", rules: "", pacUrl: "", bypass: "" };
    ($("#proxy-mode") as HTMLSelectElement).value = proxy.mode;
    ($("#proxy-rules") as HTMLInputElement).value = proxy.rules;
    ($("#proxy-pac") as HTMLInputElement).value = proxy.pacUrl;
    ($("#proxy-bypass") as HTMLInputElement).value = proxy.bypass;
    updateProxyFields();

    const dns = state.policy.dns;
    ($("#dns-mode") as HTMLSelectElement).value = dns.mode;
    ($("#dns-servers") as HTMLInputElement).value = dns.servers.join(" ");
  }

  /** Only show the input the selected mode actually uses. */
  function updateProxyFields(): void {
    const mode = ($("#proxy-mode") as HTMLSelectElement).value;
    $("#proxy-rules-row").style.display = mode === "manual" ? "" : "none";
    $("#proxy-pac-row").style.display = mode === "pac" ? "" : "none";
    $("#proxy-bypass-row").style.display = mode === "manual" || mode === "pac" ? "" : "none";
  }

  $("#proxy-mode").addEventListener("change", updateProxyFields);

  $("#proxy-apply").addEventListener("click", () => {
    const profile = activeProfile();
    if (!profile) return;
    const requested: ProxyConfig = {
      mode: ($("#proxy-mode") as HTMLSelectElement).value as ProxyConfig["mode"],
      rules: ($("#proxy-rules") as HTMLInputElement).value,
      pacUrl: ($("#proxy-pac") as HTMLInputElement).value,
      bypass: ($("#proxy-bypass") as HTMLInputElement).value,
    };
    const status = $("#proxy-status");
    status.textContent = "Applying…";

    void sable.setProfileProxy(profile.id, requested).then((stored) => {
      if (!stored) {
        status.textContent = "Failed to apply.";
        return;
      }
      // The main process rejects malformed input by falling back to the system
      // proxy. Say so plainly — silently ignoring a bad rule would leave the
      // user believing they are proxied when they are not.
      if (stored.mode !== requested.mode) {
        status.textContent = `Rejected: that ${requested.mode} setting is not valid. Left on "${stored.mode}".`;
      } else {
        status.textContent = "Applied. Reloading the Discord view.";
      }
    });
  });

  $("#dns-apply").addEventListener("click", () => {
    if (!state) return;
    const servers = ($("#dns-servers") as HTMLInputElement).value
      .split(/[\s,]+/)
      .filter((s) => s.length > 0);
    const mode = ($("#dns-mode") as HTMLSelectElement).value as DnsConfig["mode"];
    const status = $("#dns-status");

    void sable
      .setPolicy({ ...state.policy, dns: { mode, servers } })
      .then((policy) => {
        status.textContent =
          policy.dns.mode !== mode
            ? 'Needs at least one valid https:// server for "secure"; left on automatic.'
            : "Applied.";
      });
  });

  // -------------------------------------------------------------- inspector

  async function refreshLedger(): Promise<void> {
    renderLedger(await sable.getLedger());
  }

  function renderLedger(snapshot: LedgerSnapshot): void {
    const totals = $("#totals");
    totals.textContent = "";
    const entries = Object.entries(snapshot.totals);

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Nothing blocked yet.";
      totals.append(empty);
    }

    for (const [category, count] of entries.sort((a, b) => b[1] - a[1])) {
      const chip = document.createElement("span");
      chip.className = "chip";
      const value = document.createElement("b");
      value.textContent = String(count);
      chip.append(value, document.createTextNode(` ${CATEGORY_LABELS[category] ?? category}`));
      totals.append(chip);
    }

    const list = $("#ledger");
    list.textContent = "";
    for (const entry of snapshot.recent) {
      const li = document.createElement("li");
      const cat = document.createElement("span");
      cat.className = "cat";
      cat.textContent = CATEGORY_LABELS[entry.category] ?? entry.category;
      const url = document.createElement("div");
      url.className = "url";
      url.textContent = `${entry.method} ${entry.url}`;
      li.append(cat, url);
      list.append(li);
    }
  }

  $("#clear-ledger").addEventListener("click", () => {
    void sable.clearLedger().then(refreshLedger);
  });

  // ------------------------------------------------------------------ about

  function renderAbout(): void {
    if (!state) return;
    const dl = $("#about-facts");
    dl.textContent = "";

    const facts: [string, string][] = [
      ["Version", state.version],
      ["Electron", state.electron],
      ["Chromium", state.chrome],
      [
        "Storage",
        state.portable ? `Portable (${state.portableReason})` : "System application data",
      ],
      ["Data directory", state.dataDir],
      ["Runtime dependencies", "none"],
    ];
    if (state.devMode) facts.push(["Mode", "Developer — DevTools enabled"]);

    for (const [term, value] of facts) {
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = value;
      dl.append(dt, dd);
    }
  }

  // ------------------------------------------------------------------- wire

  function render(next: AppState): void {
    state = next;
    renderProfiles();
    renderPrivacy();
    renderNetwork();
    renderAbout();
  }

  sable.onStateChanged(render);
  sable.onLedgerChanged(renderLedger);
  sable.onShowPane(showPane);
  void sable.getState().then(render);
})();
