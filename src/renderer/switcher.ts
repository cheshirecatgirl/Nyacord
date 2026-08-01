/**
 * The switcher strip: DMs on one side, Servers on the other.
 *
 * This is the whole of the unified layout's UI. Everything else it does is a
 * stylesheet, injected into Discord's page from the main process, deciding
 * which of Discord's own lists is on screen. The strip does not read Discord's
 * markup, call its API, or know what is in either list; it sends one of two
 * words to the main process and redraws when it is told the answer.
 */

import { SIDEBAR_TABS, type SidebarTabId } from "../common/appearance";
import type { SwitcherState } from "../common/ipc";
import type { NyaSwitcherApi } from "../preload/switcher";

const nya = (window as unknown as { nyaSwitcher: NyaSwitcherApi }).nyaSwitcher;

const strip = document.getElementById("strip") as HTMLDivElement;
const pills: { id: SidebarTabId; el: HTMLButtonElement }[] = [];

for (const tab of SIDEBAR_TABS) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "pill";
  el.setAttribute("role", "tab");
  el.textContent = tab.label;
  el.addEventListener("click", () => void nya.select(tab.id, true));
  strip.append(el);
  pills.push({ id: tab.id, el });
}

/**
 * Arrow keys move along the strip, which is what `role="tablist"` promises.
 * Only the selected pill is tabbable, so Tab enters and leaves the strip once
 * instead of stopping on every side.
 */
strip.addEventListener("keydown", (event) => {
  const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (step === 0) return;
  event.preventDefault();

  const from = pills.findIndex((pill) => pill.el === document.activeElement);
  const next = pills[(Math.max(from, 0) + step + pills.length) % pills.length];
  if (!next) return;

  next.el.focus();
  void nya.select(next.id, false);
});

function render(state: SwitcherState): void {
  document.documentElement.classList.toggle("dark", state.dark);

  for (const pill of pills) {
    const on = pill.id === state.activeTab;
    pill.el.classList.toggle("on", on);
    pill.el.setAttribute("aria-selected", String(on));
    pill.el.tabIndex = on ? 0 : -1;
  }
}

nya.onState(render);
