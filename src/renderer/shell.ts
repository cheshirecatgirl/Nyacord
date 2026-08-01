/**
 * Settings panel UI.
 *
 * Bundled, so shared types and constants come from src/common instead of being
 * redeclared here.
 *
 * DOM is built with createElement and textContent only. The Inspector shows
 * URLs pulled off the network, so none of it may go through innerHTML.
 */

import {
  SIDEBAR_TABS,
  type AppearanceConfig,
  type LayoutMode,
} from "../common/appearance";
import { CHANNELS, CHANNEL_IDS } from "../common/channels";
import type { AppState, LedgerSnapshot, PaneId } from "../common/ipc";
import { describeProxy, proxyResolvesRemotely, type DnsConfig, type ProxyConfig } from "../common/network";
import type { GhostPolicy, PrivacyPolicy } from "../common/policy";
import type { ProfileSummary } from "../common/profile";
import { RULE_CATEGORY_LABELS } from "../common/rules";
import type { NyaApi } from "../preload/shell";

const nya = (window as unknown as { nya: NyaApi }).nya;

/** The policy fields that are a plain on/off switch. */
type BooleanPolicyKey = {
  [K in keyof PrivacyPolicy]: PrivacyPolicy[K] extends boolean ? K : never;
}[keyof PrivacyPolicy];

type ToggleDef =
  | { group: string; scope: "policy"; key: BooleanPolicyKey; title: string; detail: string }
  | { group: string; scope: "ghost"; key: keyof GhostPolicy; title: string; detail: string };

/** Drives the privacy pane. Keys are type-checked against the policy. */
const TOGGLES: readonly ToggleDef[] = [
  {
    group: "Tracking",
    scope: "policy",
    key: "blockTelemetry",
    title: "Block Discord analytics",
    detail: "Drops requests to /api/science and friends.",
  },
  {
    group: "Tracking",
    scope: "policy",
    key: "blockErrorReporting",
    title: "Block crash & error reporting",
    detail: "Stops Sentry uploads, which can include context about your session.",
  },
  {
    group: "Tracking",
    scope: "policy",
    key: "blockThirdPartyTrackers",
    title: "Block third-party trackers",
    detail: "Known analytics hosts, blocked by name.",
  },
  {
    group: "Tracking",
    scope: "policy",
    key: "blockBrowserServices",
    title: "Block browser background services",
    detail: "Chromium's own calls home: component updates, Safe Browsing, dictionaries.",
  },
  {
    group: "Ghost mode",
    scope: "ghost",
    key: "enabled",
    title: "Ghost mode",
    detail: "Master switch for the suppressions below.",
  },
  {
    group: "Ghost mode",
    scope: "ghost",
    key: "suppressTyping",
    title: "Never send typing indicators",
    detail: "Others will not see “… is typing” from you.",
  },
  {
    group: "Ghost mode",
    scope: "ghost",
    key: "suppressReadReceipts",
    title: "Never acknowledge reads",
    detail:
      "The server is not told you read a message. Unread badges may persist and will not sync to your phone.",
  },
  {
    group: "Ghost mode",
    scope: "ghost",
    key: "suppressCallReports",
    title: "Never upload call quality reports",
    detail: "Post-call voice/video telemetry.",
  },
  {
    group: "Exposure",
    scope: "policy",
    key: "blockActivities",
    title: "Block embedded activities",
    detail: "Mini-apps served from discordsays.com run third-party code.",
  },
  {
    group: "Exposure",
    scope: "policy",
    key: "blockThirdPartyMedia",
    title: "Block off-platform media",
    detail:
      "Link previews and embeds will not load from non-Discord hosts, so they cannot log your IP. Breaks some images.",
  },
  {
    group: "Fingerprinting",
    scope: "policy",
    key: "sanitizeUserAgent",
    title: "Sanitize User-Agent",
    detail: "Removes the Electron and product tokens so requests look like stock Chromium.",
  },
  {
    group: "Fingerprinting",
    scope: "policy",
    key: "normalizeClientHints",
    title: "Normalize client hints",
    detail: "Keeps Sec-CH-UA consistent with the sanitized User-Agent.",
  },
  {
    group: "Fingerprinting",
    scope: "policy",
    key: "minimizeReferrer",
    title: "Minimize Referer",
    detail: "Send an origin for same-site requests and nothing cross-site.",
  },
  {
    group: "Fingerprinting",
    scope: "policy",
    key: "globalPrivacyControl",
    title: "Send Global Privacy Control",
    detail: "Sends Sec-GPC: 1, an opt-out signal with legal weight in some places.",
  },
  {
    group: "System",
    scope: "policy",
    key: "spellcheck",
    title: "Spellchecker",
    detail: "Off by default because Chromium fetches dictionaries from Google on first use.",
  },
];

const PRESETS = ["balanced", "strict", "paranoid"] as const;

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector(selector) as T;

function button(label: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.textContent = label;
  el.addEventListener("click", onClick);
  return el;
}

let state: AppState | null = null;

// -------------------------------------------------------------------- panes

function showPane(pane: PaneId): void {
  for (const el of document.querySelectorAll<HTMLElement>(".pane")) {
    const selected = el.dataset["pane"] === pane;
    el.classList.toggle("hidden", !selected);
    if (selected) $("#pane-title").textContent = el.dataset["title"] ?? "";
  }
  for (const el of document.querySelectorAll<HTMLElement>(".tab")) {
    const selected = el.dataset["pane"] === pane;
    el.classList.toggle("active", selected);
    el.setAttribute("aria-selected", String(selected));
  }
  if (pane === "inspector") void refreshLedger();
}

for (const tab of document.querySelectorAll<HTMLElement>(".tab")) {
  tab.setAttribute("role", "tab");
  tab.addEventListener("click", () => showPane(tab.dataset["pane"] as PaneId));
}

$("#close").addEventListener("click", () => void nya.closePanel());
$("#backdrop").addEventListener("click", () => void nya.closePanel());
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") void nya.closePanel();
});

// ----------------------------------------------------------------- profiles

function renderProfiles(): void {
  const list = $("#profile-list");
  list.textContent = "";
  if (!state) return;

  for (const profile of state.profiles) {
    const li = document.createElement("li");
    if (profile.active) li.classList.add("active");

    const channel = CHANNELS[profile.channel];

    const dot = document.createElement("span");
    dot.className = `dot ${profile.channel}`;
    li.append(dot);

    const grow = document.createElement("div");
    grow.className = "grow";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = profile.name;

    const sub = document.createElement("div");
    sub.className = "sub";
    // Shows egress per profile, so a proxied identity is obvious at a glance.
    sub.textContent = [
      channel.label,
      profile.ephemeral ? "ephemeral" : null,
      profile.proxy.mode === "system" ? null : describeProxy(profile.proxy),
    ]
      .filter((part): part is string => part !== null)
      .join(" · ");

    grow.append(name, sub);
    li.append(grow);

    if (profile.badge > 0) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = String(profile.badge);
      li.append(badge);
    }

    if (!profile.active) li.append(button("Open", () => void nya.switchProfile(profile.id)));

    li.append(
      button("Rename", () => {
        const next = window.prompt("New name", profile.name);
        if (next) void nya.renameProfile(profile.id, next);
      }),
    );
    li.append(
      button("Sign out", () => {
        if (window.confirm(`Clear all stored data for "${profile.name}"?`)) {
          void nya.clearProfileData(profile.id);
        }
      }),
    );

    if (state.profiles.length > 1) {
      const remove = button("Delete", () => {
        if (window.confirm(`Delete the profile "${profile.name}" and its data?`)) {
          void nya.deleteProfile(profile.id);
        }
      });
      remove.classList.add("danger");
      li.append(remove);
    }

    list.append(li);
  }
}

function populateChannelOptions(): void {
  const select = $("#new-channel") as HTMLSelectElement;
  select.textContent = "";
  for (const id of CHANNEL_IDS) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = CHANNELS[id].label;
    option.title = CHANNELS[id].description;
    select.append(option);
  }
}

$("#new-profile").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = ($("#new-name") as HTMLInputElement).value;
  const channel = ($("#new-channel") as HTMLSelectElement).value as ProfileSummary["channel"];
  const ephemeral = ($("#new-ephemeral") as HTMLInputElement).checked;
  void nya.createProfile({ name, channel, ephemeral }).then(() => {
    ($("#new-name") as HTMLInputElement).value = "";
    ($("#new-ephemeral") as HTMLInputElement).checked = false;
  });
});

// ------------------------------------------------------------------ privacy

function renderPrivacy(): void {
  if (!state) return;
  const policy = state.policy;

  const presets = $("#presets");
  presets.textContent = "";
  for (const name of PRESETS) {
    const el = button(name[0]!.toUpperCase() + name.slice(1), () => void nya.applyPreset(name));
    if (policy.preset === name) el.classList.add("active");
    presets.append(el);
  }

  $("#preset-note").textContent =
    policy.preset === "custom"
      ? "Custom: you have changed individual settings."
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
    input.checked =
      toggle.scope === "ghost" ? policy.ghost[toggle.key] : policy[toggle.key];

    // Sub-toggles do nothing while the master switch is off, so disable them.
    if (toggle.scope === "ghost" && toggle.key !== "enabled" && !policy.ghost.enabled) {
      input.disabled = true;
      row.classList.add("inactive");
    }

    input.addEventListener("change", () => {
      const next: PrivacyPolicy = { ...policy, ghost: { ...policy.ghost } };
      if (toggle.scope === "ghost") next.ghost[toggle.key] = input.checked;
      else next[toggle.key] = input.checked;
      void nya.setPolicy(next);
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

// ------------------------------------------------------------------ network

function activeProfile(): ProfileSummary | undefined {
  return state?.profiles.find((p) => p.active);
}

function renderNetwork(): void {
  if (!state) return;
  const profile = activeProfile();
  $("#proxy-profile").textContent = profile ? profile.name : "no profile";

  const proxy: ProxyConfig = profile?.proxy ?? {
    mode: "system",
    rules: "",
    pacUrl: "",
    bypass: "",
  };
  ($("#proxy-mode") as HTMLSelectElement).value = proxy.mode;
  ($("#proxy-rules") as HTMLInputElement).value = proxy.rules;
  ($("#proxy-pac") as HTMLInputElement).value = proxy.pacUrl;
  ($("#proxy-bypass") as HTMLInputElement).value = proxy.bypass;
  updateProxyFields();

  ($("#dns-mode") as HTMLSelectElement).value = state.dns.mode;
  ($("#dns-servers") as HTMLInputElement).value = state.dns.servers.join(" ");
}

/** Show only the field the selected mode uses. */
function updateProxyFields(): void {
  const mode = ($("#proxy-mode") as HTMLSelectElement).value;
  $("#proxy-rules-row").classList.toggle("hidden", mode !== "manual");
  $("#proxy-pac-row").classList.toggle("hidden", mode !== "pac");
  $("#proxy-bypass-row").classList.toggle("hidden", mode !== "manual" && mode !== "pac");
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

  void nya.setProfileProxy(profile.id, requested).then((stored) => {
    if (!stored) {
      status.textContent = "Failed to apply.";
      return;
    }
    // Bad input falls back to the system proxy in the main process. Say so:
    // swallowing it would leave the user thinking they are proxied.
    if (stored.mode !== requested.mode) {
      status.textContent = `Rejected: that ${requested.mode} setting is not valid. Left on "${stored.mode}".`;
    } else if (proxyResolvesRemotely(stored)) {
      status.textContent = "Applied. SOCKS resolves hostnames at the proxy, so DNS does not leak locally.";
    } else {
      status.textContent = "Applied. Reloading the Discord view.";
    }
  });
});

$("#dns-apply").addEventListener("click", () => {
  const mode = ($("#dns-mode") as HTMLSelectElement).value as DnsConfig["mode"];
  const servers = ($("#dns-servers") as HTMLInputElement).value
    .split(/[\s,]+/)
    .filter((s) => s.length > 0);
  const status = $("#dns-status");

  void nya.setDns({ mode, servers }).then((dns) => {
    status.textContent =
      dns.mode !== mode
        ? 'Needs at least one valid https:// server for "secure"; left on automatic.'
        : "Applied.";
  });
});

// --------------------------------------------------------------- appearance

/** Small helper for the miniature layout previews. */
function mock(className: string, ...children: Node[]): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  el.append(...children);
  return el;
}

function mockRow(avatar: string, extra = ""): HTMLDivElement {
  return mock(`mock-row ${extra}`.trim(), mock(`mock-avatar ${avatar}`.trim()), mock("mock-line"));
}

function mockTab(active: boolean, width: "sm" | "md"): HTMLDivElement {
  return mock(`mock-tab ${width}${active ? " on" : ""}`);
}

/**
 * The unified column: a two-way switcher on top, one list below.
 *
 * Showing one side at a time is what keeps the column short. Stacking both in
 * one scroll would be two lists in one container.
 */
function unifiedMock(): HTMLDivElement {
  return mock(
    "mock",
    mock(
      "mock-col",
      mock("mock-switcher", mockTab(true, "sm"), mockTab(false, "md")),
      mock(
        "mock-list",
        mockRow("violet"),
        mockRow("rose", "on"),
        mockRow("green square"),
        mockRow("amber square"),
        mockRow("cyan"),
      ),
    ),
    mock("mock-pane"),
  );
}

/** Discord's own arrangement: an icon rail, then a separate list. */
function classicMock(): HTMLDivElement {
  const caret = document.createElement("span");
  caret.className = "mock-caret";
  return mock(
    "mock",
    mock(
      "mock-rail",
      mock("mock-avatar green square"),
      mock("mock-avatar amber square"),
      mock("mock-avatar cyan square"),
    ),
    mock(
      "mock-list",
      mock("mock-group", caret, mock("mock-line short bright")),
      mockRow("violet"),
      mockRow("rose", "on"),
      mockRow("cyan"),
    ),
    mock("mock-pane"),
  );
}

const LAYOUT_CARDS: {
  mode: LayoutMode;
  title: string;
  tag: string;
  desc: string;
  preview: () => HTMLDivElement;
}[] = [
  {
    mode: "unified",
    title: "Unified",
    tag: "Default",
    desc:
      "One column with a switcher on top. DMs and Servers share the strip, so moving between them is a single click and only one list is on screen.",
    preview: unifiedMock,
  },
  {
    mode: "classic",
    title: "Classic",
    tag: "Discord",
    desc: "Discord's own arrangement: a server icon rail with a separate channel and DM column.",
    preview: classicMock,
  },
];

function appearance(): AppearanceConfig {
  return state?.appearance ?? { layout: "unified", activeTab: "dms" };
}

function saveAppearance(next: AppearanceConfig): void {
  void nya.setAppearance(next).then((stored) => {
    if (state) state = { ...state, appearance: stored };
    renderAppearance();
  });
}

function renderAppearance(): void {
  const current = appearance();

  const cards = $("#layouts");
  cards.textContent = "";
  for (const card of LAYOUT_CARDS) {
    const el = document.createElement("button");
    el.className = card.mode === current.layout ? "layout-card selected" : "layout-card";
    el.setAttribute("aria-pressed", String(card.mode === current.layout));

    const title = mock("title");
    const label = document.createElement("span");
    label.textContent = card.title;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = card.tag;
    title.append(label, tag);

    const desc = mock("desc");
    desc.textContent = card.desc;

    el.append(card.preview(), title, desc);
    el.addEventListener("click", () => saveAppearance({ ...current, layout: card.mode }));
    cards.append(el);
  }

  // Only worth saying when the switcher below is inert; under Unified the
  // strip speaks for itself.
  const note = $("#layout-note");
  note.classList.toggle("hidden", current.layout === "unified");
  note.textContent =
    "The switcher belongs to the unified layout. Your choice stays saved while Classic is selected.";

  renderSwitcher(current);
}

/** The switcher itself, built from the same data the layout uses. */
function renderSwitcher(current: AppearanceConfig): void {
  const strip = $("#switcher");
  strip.textContent = "";

  for (const tab of SIDEBAR_TABS) {
    const pill = document.createElement("button");
    const active = tab.id === current.activeTab;
    pill.className = active ? "pill on" : "pill";
    pill.setAttribute("role", "tab");
    pill.setAttribute("aria-selected", String(active));
    pill.textContent = tab.label;
    pill.addEventListener("click", () => saveAppearance({ ...current, activeTab: tab.id }));
    strip.append(pill);
  }
}

// ---------------------------------------------------------------- inspector

async function refreshLedger(): Promise<void> {
  renderLedger(await nya.getLedger());
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

  for (const [category, count] of entries.sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const value = document.createElement("b");
    value.textContent = String(count);
    const label = RULE_CATEGORY_LABELS[category as keyof typeof RULE_CATEGORY_LABELS] ?? category;
    chip.append(value, document.createTextNode(` ${label}`));
    totals.append(chip);
  }

  const list = $("#ledger");
  list.textContent = "";
  for (const entry of snapshot.recent) {
    const li = document.createElement("li");
    const cat = document.createElement("span");
    cat.className = "cat";
    cat.textContent = RULE_CATEGORY_LABELS[entry.category] ?? entry.category;
    const url = document.createElement("div");
    url.className = "url";
    url.textContent = `${entry.method} ${entry.url}`;
    li.append(cat, url);
    list.append(li);
  }
}

$("#clear-ledger").addEventListener("click", () => {
  void nya.clearLedger().then(refreshLedger);
});

// -------------------------------------------------------------------- about

function renderAbout(): void {
  if (!state) return;
  const dl = $("#about-facts");
  dl.textContent = "";

  const facts: [string, string][] = [
    ["Version", state.version],
    ["Electron", state.electron],
    ["Chromium", state.chrome],
    ["Storage", state.portable ? `Portable (${state.portableReason})` : "System application data"],
    ["Data directory", state.dataDir],
    ["Runtime dependencies", "none"],
  ];
  if (state.devMode) facts.push(["Mode", "Developer (DevTools enabled)"]);

  for (const [term, value] of facts) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dl.append(dt, dd);
  }
}

// --------------------------------------------------------------------- wire

function render(next: AppState): void {
  state = next;
  renderProfiles();
  renderPrivacy();
  renderNetwork();
  renderAppearance();
  renderAbout();
}

populateChannelOptions();
nya.onStateChanged(render);
nya.onLedgerChanged(renderLedger);
nya.onShowPane(showPane);
void nya.getState().then(render);
