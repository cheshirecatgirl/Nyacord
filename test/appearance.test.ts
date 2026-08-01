import { strict as assert } from "node:assert";
import { test, describe } from "node:test";

import {
  SIDEBAR_TABS,
  contextFromPath,
  contextFromUrl,
  defaultAppearance,
  isLayoutMode,
  isSidebarTab,
  normalizeAppearance,
  tabForContext,
} from "../src/common/appearance";

describe("normalizeAppearance", () => {
  test("defaults to the unified layout showing DMs", () => {
    const value = normalizeAppearance(undefined);
    assert.deepEqual(value, defaultAppearance());
    assert.equal(value.layout, "unified");
    assert.equal(value.activeTab, "dms");
  });

  test("survives garbage", () => {
    for (const input of [null, 7, "x", [], { layout: "wat", activeTab: "nope" }]) {
      const value = normalizeAppearance(input);
      assert.equal(isLayoutMode(value.layout), true);
      assert.equal(isSidebarTab(value.activeTab), true);
    }
  });

  test("keeps a valid choice", () => {
    const value = normalizeAppearance({ layout: "classic", activeTab: "servers" });
    assert.equal(value.layout, "classic");
    assert.equal(value.activeTab, "servers");
  });

  test("has exactly the two built-in tabs", () => {
    // Discord already has server folders with drag and drop, synced to the
    // account. A second folder system would duplicate it by hand.
    assert.deepEqual(
      SIDEBAR_TABS.map((tab) => tab.id),
      ["dms", "servers"],
    );
  });
});

describe("chat context", () => {
  test("reads direct messages from the path", () => {
    assert.deepEqual(contextFromPath("/channels/@me"), { kind: "dms" });
    assert.deepEqual(contextFromPath("/channels/@me/123"), { kind: "dms" });
  });

  test("reads the guild id from a server path", () => {
    assert.deepEqual(contextFromPath("/channels/456"), { kind: "server", guildId: "456" });
    assert.deepEqual(contextFromPath("/channels/456/789"), { kind: "server", guildId: "456" });
  });

  test("returns other for anything that is not a chat", () => {
    for (const path of ["/", "/login", "/app", "/channels", "/channels/abc"]) {
      assert.deepEqual(contextFromPath(path), { kind: "other" }, path);
    }
  });

  test("works from a full URL on any release channel", () => {
    // This is what lets the switcher follow navigation without a preload: the
    // web app's routes are URLs, so the main process can read them directly.
    assert.deepEqual(contextFromUrl("https://discord.com/channels/@me/1"), { kind: "dms" });
    assert.deepEqual(contextFromUrl("https://canary.discord.com/channels/2/3"), {
      kind: "server",
      guildId: "2",
    });
  });

  test("does not throw on a malformed URL", () => {
    assert.deepEqual(contextFromUrl("not a url"), { kind: "other" });
  });

  test("maps a context back to the tab that should be showing", () => {
    assert.equal(tabForContext({ kind: "dms" }), "dms");
    assert.equal(tabForContext({ kind: "server", guildId: "1" }), "servers");
    assert.equal(tabForContext({ kind: "other" }), null);
  });
});
