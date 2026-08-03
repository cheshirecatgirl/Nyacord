/**
 * Splits the unified layout's stylesheet into what applies always and what
 * applies to one side of the switcher.
 *
 * Switching sides cannot set a class on Discord's page without running script
 * in it, so the main process injects a different stylesheet per side and
 * removes the previous one. The file is one document with marked sections:
 *
 *     [shared]    both sides
 *     [dms]       the direct messages side
 *     [servers]   the servers side
 *
 * Anything before the first marker counts as shared. The format stays dull
 * because you will be editing it with DevTools open the next time Discord
 * changes its markup.
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
 * A stylesheet whose selectors match nothing looks identical to a working one
 * from here. All this catches is an empty or truncated file, which is still
 * worth knowing: it is what tells the app to drop the switcher strip.
 */
export function isEmptyStylesheet(sheet: LayoutStylesheet): boolean {
  return !sheet.shared && !sheet.dms && !sheet.servers;
}
