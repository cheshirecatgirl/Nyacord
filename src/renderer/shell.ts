/**
 * Shell UI.
 *
 * Bundled, so it imports the real definitions from `src/common` rather than
 * re-declaring them. Channel names and accents, rule-category labels and every
 * shared type have exactly one definition in the codebase.
 *
 * All DOM is built with `createElement` and `textContent`; there is no
 * `innerHTML` anywhere, which matters because the Privacy Inspector renders
 * URLs that came off the network. They must be inert text, and they are.
 */

import {
  FOLDER_TONES,
  MAX_FOLDERS,
  folderTabs,
  isDirectMessageTarget,
  normalizeChatTarget,
  type AppearanceConfig,
  type ChatFolder,
  type FolderTone,
  type LayoutMode,
} from "../common/appearance";
import { CHANNELS, CHANNEL_IDS } from "../common/channels";
import type { AppState, LedgerSnapshot, PaneId } from "../common/ipc";
import { describeProxy, proxyResolvesRemotely, type DnsConfig, type ProxyConfig } from "../common/network";
import type { GhostPolicy, PrivacyPolicy } from "../common/policy";
import type { ProfileSummary } from "../common/profile";
import { RULE_CATEGORY_LABELS } from "../common/rules";
import type { NyacordApi } from "../preload/shell";

const nyacord = (window as unknown as { nyacord: NyacordApi }).nyacord;

/** The policy fields that are a plain on/off switch. */
type BooleanPolicyKey = {
  [K in keyof PrivacyPolicy]: PrivacyPolicy[K] extends boolean ? K : never;
}[keyof PrivacyPolicy];

type ToggleDef =
  | { group: string; scope: "policy"; key: BooleanPolicyKey; title: string; detail: string }
  | { group: string; scope: "ghost"; key: keyof GhostPolicy; title: string; detail: string };

/**
 * The privacy pane is generated from this table, so a policy field cannot ship
 * without a user-facing explanation of what it does. The keys are checked
 * against the policy type at compile time.
 */
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
    detail: "Sec-GPC: 1 — a legally recognised opt-out signal in some jurisdictions.",
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

$("#close").addEventListener("click", () => void nyacord.closePanel());
$("#backdrop").addEventListener("click", () => void nyacord.closePanel());
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") void nyacord.closePanel();
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
    // Egress is shown per profile so it is obvious at a glance which identity
    // is proxied and which is not.
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

    if (!profile.active) li.append(button("Open", () => void nyacord.switchProfile(profile.id)));

    li.append(
      button("Rename", () => {
        const next = window.prompt("New name", profile.name);
        if (next) void nyacord.renameProfile(profile.id, next);
      }),
    );
    li.append(
      button("Sign out", () => {
        if (window.confirm(`Clear all stored data for "${profile.name}"?`)) {
          void nyacord.clearProfileData(profile.id);
        }
      }),
    );

    if (state.profiles.length > 1) {
      const remove = button("Delete", () => {
        if (window.confirm(`Delete the profile "${profile.name}" and its data?`)) {
          void nyacord.deleteProfile(profile.id);
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
  void nyacord.createProfile({ name, channel, ephemeral }).then(() => {
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
    const el = button(name[0]!.toUpperCase() + name.slice(1), () => void nyacord.applyPreset(name));
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
    input.checked =
      toggle.scope === "ghost" ? policy.ghost[toggle.key] : policy[toggle.key];

    // Sub-toggles are meaningless while the master switch is off; disable them
    // rather than letting someone set a suppression that does nothing.
    if (toggle.scope === "ghost" && toggle.key !== "enabled" && !policy.ghost.enabled) {
      input.disabled = true;
      row.classList.add("inactive");
    }

    input.addEventListener("change", () => {
      const next: PrivacyPolicy = { ...policy, ghost: { ...policy.ghost } };
      if (toggle.scope === "ghost") next.ghost[toggle.key] = input.checked;
      else next[toggle.key] = input.checked;
      void nyacord.setPolicy(next);
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

/** Only show the input the selected mode actually uses. */
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

  void nyacord.setProfileProxy(profile.id, requested).then((stored) => {
    if (!stored) {
      status.textContent = "Failed to apply.";
      return;
    }
    // The main process rejects malformed input by falling back to the system
    // proxy. Say so plainly — silently ignoring a bad rule would leave the
    // user believing they are proxied when they are not.
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

  void nyacord.setDns({ mode, servers }).then((dns) => {
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

function mockGroup(): HTMLDivElement {
  const caret = document.createElement("span");
  caret.className = "mock-caret";
  return mock("mock-group", caret, mock("mock-line short bright"));
}

function mockTab(active: boolean, width: "sm" | "md" | "lg"): HTMLDivElement {
  return mock(`mock-tab ${width}${active ? " on" : ""}`);
}

/**
 * The unified column: a folder switcher along the top, one list below it.
 *
 * Only the active folder is shown, which is what keeps the column short — the
 * alternative, both groups stacked in one scroll, is two lists sharing a
 * container rather than a merged navigation surface.
 */
function unifiedMock(): HTMLDivElement {
  return mock(
    "mock",
    mock(
      "mock-col",
      mock("mock-switcher", mockTab(true, "sm"), mockTab(false, "md"), mockTab(false, "sm"), mockTab(false, "md")),
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
  return mock(
    "mock",
    mock(
      "mock-rail",
      mock("mock-avatar green square"),
      mock("mock-avatar amber square"),
      mock("mock-avatar cyan square"),
    ),
    mock("mock-list", mockGroup(), mockRow("violet"), mockRow("rose", "on"), mockRow("cyan")),
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
      "One column with a small folder switcher on top. DMs, Servers and your own folders are tabs in the same strip, so you move between them in one click without changing navigation surface — and the list stays short because only the active folder is shown.",
    preview: unifiedMock,
  },
  {
    mode: "classic",
    title: "Classic",
    tag: "Discord",
    desc:
      "Discord's own arrangement: a server icon rail on the far left with a separate channel and DM column beside it.",
    preview: classicMock,
  },
];

function appearance(): AppearanceConfig {
  return state?.appearance ?? { layout: "unified", folders: [], activeFolder: "dms" };
}

function saveAppearance(next: AppearanceConfig, status?: string): void {
  void nyacord.setAppearance(next).then((stored) => {
    if (state) state = { ...state, appearance: stored };
    renderAppearance();
    if (status) $("#folder-status").textContent = status;
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

  $("#layout-note").textContent =
    current.layout === "unified"
      ? "DMs and Servers are always the first two tabs. Your folders follow them."
      : "The switcher and folders belong to the unified layout. They stay saved while Classic is selected.";

  renderSwitcher(current);
  renderFolders(current);
}

/**
 * The switcher itself, rendered from the same data the layout uses rather than
 * as a picture of it — so what is shown here is what ships.
 */
function renderSwitcher(current: AppearanceConfig): void {
  const strip = $("#switcher");
  strip.textContent = "";

  for (const tab of folderTabs(current)) {
    const pill = document.createElement("button");
    const active = tab.id === current.activeFolder;
    pill.className = active ? "pill on" : "pill";
    pill.setAttribute("role", "tab");
    pill.setAttribute("aria-selected", String(active));

    const tone = document.createElement("span");
    tone.className = `tone ${tab.tone}`;
    pill.append(tone);

    const label = document.createElement("span");
    label.textContent = tab.label;
    pill.append(label);

    // Built-in tabs are filled by Discord, so a count would be a number we do
    // not have rather than a zero.
    if (!tab.builtin) {
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = String(tab.count);
      pill.append(count);
    }

    pill.addEventListener("click", () => saveAppearance({ ...current, activeFolder: tab.id }));
    strip.append(pill);
  }
}

function renderFolders(current: AppearanceConfig): void {
  const list = $("#folder-list");
  list.textContent = "";

  if (current.folders.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No folders yet.";
    list.append(empty);
  }

  current.folders.forEach((folder, index) => {
    const li = document.createElement("li");
    const head = mock("folder-head");

    const tone = document.createElement("span");
    tone.className = `tone ${folder.tone}`;
    head.append(tone);

    const grow = mock("grow");
    const name = mock("name");
    name.textContent = folder.name;
    const sub = mock("sub");
    sub.textContent = `${folder.entries.length} chat${folder.entries.length === 1 ? "" : "s"}`;
    grow.append(name, sub);
    head.append(grow);

    head.append(
      button("Tone", () => {
        // Cycling beats a colour picker here: the palette is closed, so a
        // click is faster than choosing from a menu of six.
        const next = FOLDER_TONES[(FOLDER_TONES.indexOf(folder.tone) + 1) % FOLDER_TONES.length];
        update(index, (draft) => {
          draft.tone = next as FolderTone;
        });
      }),
    );
    head.append(
      button("Rename", () => {
        const value = window.prompt("Folder name", folder.name);
        if (value) update(index, (draft) => void (draft.name = value));
      }),
    );
    head.append(button("Add chat", () => addEntry(index)));
    if (index > 0) head.append(button("↑", () => moveFolder(index, -1)));
    if (index < current.folders.length - 1) head.append(button("↓", () => moveFolder(index, 1)));

    const remove = button("Delete", () => {
      if (window.confirm(`Delete the folder "${folder.name}"?`)) {
        saveAppearance({
          ...current,
          folders: current.folders.filter((_, i) => i !== index),
        });
      }
    });
    remove.classList.add("danger");
    head.append(remove);

    li.append(head);

    if (folder.entries.length > 0) {
      const entries = document.createElement("ul");
      entries.className = "folder-entries";
      folder.entries.forEach((entry, entryIndex) => {
        const row = document.createElement("li");

        const kind = document.createElement("span");
        kind.className = "kind";
        kind.textContent = isDirectMessageTarget(entry.target) ? "DM" : "Server";
        row.append(kind);

        const grow2 = mock("grow");
        const entryName = mock("name");
        entryName.textContent = entry.name;
        const target = mock("entry-target");
        target.textContent = entry.target;
        grow2.append(entryName, target);
        row.append(grow2);

        row.append(button("Open", () => void nyacord.openChat(entry.target)));
        const drop = button("Remove", () =>
          update(index, (draft) => {
            draft.entries = draft.entries.filter((_, i) => i !== entryIndex);
          }),
        );
        drop.classList.add("danger");
        row.append(drop);

        entries.append(row);
      });
      li.append(entries);
    }

    list.append(li);
  });

  function update(index: number, mutate: (folder: ChatFolder) => void): void {
    const folders = current.folders.map((folder, i) =>
      i === index ? { ...folder, entries: [...folder.entries] } : folder,
    );
    const target = folders[index];
    if (!target) return;
    mutate(target);
    saveAppearance({ ...current, folders });
  }

  function moveFolder(index: number, delta: number): void {
    const folders = [...current.folders];
    const [moved] = folders.splice(index, 1);
    if (moved) folders.splice(index + delta, 0, moved);
    saveAppearance({ ...current, folders });
  }

  function addEntry(index: number): void {
    const raw = window.prompt(
      "Paste a Discord link or channel path\n(e.g. https://discord.com/channels/@me/123)",
      "",
    );
    if (!raw) return;

    // Validated here as well as in the main process, purely so the message can
    // be specific instead of the entry silently vanishing on save.
    const target = normalizeChatTarget(raw);
    if (!target) {
      $("#folder-status").textContent = "That is not a Discord channel link.";
      return;
    }

    const name = window.prompt("Name for this chat", isDirectMessageTarget(target) ? "DM" : "Server");
    if (!name) return;

    update(index, (draft) => {
      draft.entries = [
        ...draft.entries,
        { id: `e${Date.now().toString(36)}`, name, target },
      ];
    });
    $("#folder-status").textContent = "";
  }
}

$("#folder-add").addEventListener("click", () => {
  const current = appearance();
  if (current.folders.length >= MAX_FOLDERS) {
    $("#folder-status").textContent = `Limit is ${MAX_FOLDERS} folders.`;
    return;
  }
  const name = window.prompt("Folder name", "New folder");
  if (!name) return;

  saveAppearance(
    {
      ...current,
      folders: [
        ...current.folders,
        {
          id: `f${Date.now().toString(36)}`,
          name,
          tone: FOLDER_TONES[current.folders.length % FOLDER_TONES.length] ?? "violet",
          entries: [],
        },
      ],
    },
    "",
  );
});

// ---------------------------------------------------------------- inspector

async function refreshLedger(): Promise<void> {
  renderLedger(await nyacord.getLedger());
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
  void nyacord.clearLedger().then(refreshLedger);
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
  if (state.devMode) facts.push(["Mode", "Developer — DevTools enabled"]);

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
nyacord.onStateChanged(render);
nyacord.onLedgerChanged(renderLedger);
nyacord.onShowPane(showPane);
void nyacord.getState().then(render);
