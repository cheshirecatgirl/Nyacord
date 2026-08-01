/**
 * The unified layout's stylesheet, split into the parts that apply always and
 * the parts that apply to one side of the switcher.
 *
 * Switching sides cannot set a class on Discord's page, because that would
 * mean running script in it. Instead the main process injects a different
 * stylesheet per side and removes the previous one. So the file is one
 * document with marked sections, and this module picks the sections that
 * belong to the current side.
 *
 * The format is deliberately dull, because you will be editing it with
 * DevTools open when Discord next changes its markup:
 *
 *     [shared]    rules that apply on both sides
 *     [dms]       rules for the direct messages side
 *     [servers]   rules for the servers side
 *
 * Anything before the first marker is treated as shared.
 */

import type { SidebarTabId } from "./appearance";

export interface LayoutStylesheet {
  readonly shared: string;
  readonly dms: string;
  readonly servers: string;
}

const MARKER = /^[ \t]*\/\*[ \t]*\[(shared|dms|servers)\][ \t]*\*\/[ \t]*$/gm;

export function parseLayoutStylesheet(text: string): LayoutStylesheet {
  const sections: Record<keyof LayoutStylesheet, string[]> = { shared: [], dms: [], servers: [] };
  let current: keyof LayoutStylesheet = "shared";
  let cursor = 0;

  MARKER.lastIndex = 0;
  for (let match = MARKER.exec(text); match; match = MARKER.exec(text)) {
    sections[current].push(text.slice(cursor, match.index));
    current = match[1] as keyof LayoutStylesheet;
    cursor = match.index + match[0].length;
  }
  sections[current].push(text.slice(cursor));

  return {
    shared: sections.shared.join("").trim(),
    dms: sections.dms.join("").trim(),
    servers: sections.servers.join("").trim(),
  };
}

/** The stylesheet to inject for one side of the switcher. */
export function composeLayoutCss(sheet: LayoutStylesheet, tab: SidebarTabId): string {
  return [sheet.shared, tab === "dms" ? sheet.dms : sheet.servers].filter(Boolean).join("\n\n");
}

/**
 * A stylesheet that matches nothing is the normal state after Discord changes
 * its markup, and it is indistinguishable from a working one at the CSS level.
 * The only thing we can check cheaply is whether the file still contains
 * anything to apply, which catches an empty or truncated file.
 */
export function isEmptyStylesheet(sheet: LayoutStylesheet): boolean {
  return !sheet.shared && !sheet.dms && !sheet.servers;
}
