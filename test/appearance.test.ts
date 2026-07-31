import { strict as assert } from "node:assert";
import { test, describe } from "node:test";

import {
  MAX_FOLDERS,
  defaultAppearance,
  isDirectMessageTarget,
  normalizeAppearance,
  normalizeChatTarget,
} from "../src/common/appearance";

describe("chat targets", () => {
  test("accepts DM and server links from any release channel", () => {
    const cases: [string, string][] = [
      ["https://discord.com/channels/@me/123", "/channels/@me/123"],
      ["https://ptb.discord.com/channels/456/789", "/channels/456/789"],
      ["https://canary.discord.com/channels/456", "/channels/456"],
      ["/channels/@me/123", "/channels/@me/123"],
      ["channels/456/789", "/channels/456/789"],
      ["https://discord.com/channels/456/789/", "/channels/456/789"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(normalizeChatTarget(input), expected, input);
    }
  });

  test("keeps only the path, so a folder works across channels", () => {
    // The same folder has to be valid whether the profile is Stable or Canary.
    assert.equal(
      normalizeChatTarget("https://canary.discord.com/channels/@me/1"),
      normalizeChatTarget("https://discord.com/channels/@me/1"),
    );
  });

  test("rejects anything that is not a Discord channel path", () => {
    const invalid = [
      "",
      "   ",
      "https://evil.com/channels/@me/123",
      "https://discord.com.evil.net/channels/@me/1",
      "https://discord.com/login",
      "https://discord.com/channels/@me",
      "https://discord.com/channels/abc/def",
      "javascript:alert(1)",
      "/channels/@me/123/456",
      42,
      null,
    ];
    for (const input of invalid) {
      assert.equal(normalizeChatTarget(input), null, JSON.stringify(input));
    }
  });

  test("classifies DMs against servers", () => {
    assert.equal(isDirectMessageTarget("/channels/@me/1"), true);
    assert.equal(isDirectMessageTarget("/channels/1/2"), false);
  });
});

describe("normalizeAppearance", () => {
  test("defaults to the unified layout with no invented folders", () => {
    const value = normalizeAppearance(undefined);
    assert.deepEqual(value, defaultAppearance());
    assert.equal(value.layout, "unified");
    assert.deepEqual(value.folders, []);
  });

  test("survives garbage", () => {
    for (const input of [null, 7, "x", [], { layout: "wat", folders: "nope" }]) {
      const value = normalizeAppearance(input);
      assert.equal(value.layout, "unified");
      assert.deepEqual(value.folders, []);
    }
  });

  test("keeps a valid folder and its entries", () => {
    const value = normalizeAppearance({
      layout: "classic",
      folders: [
        {
          id: "work",
          name: "Work",
          tone: "green",
          collapsed: true,
          entries: [{ id: "a", name: "Standup", target: "https://discord.com/channels/1/2" }],
        },
      ],
    });
    assert.equal(value.layout, "classic");
    assert.equal(value.folders.length, 1);
    assert.equal(value.folders[0]?.tone, "green");
    assert.equal(value.folders[0]?.collapsed, true);
    assert.equal(value.folders[0]?.entries[0]?.target, "/channels/1/2");
  });

  test("drops entries whose target cannot be trusted", () => {
    // A folder entry that pointed off-platform would be a link out of the app
    // rendered as if it were a chat.
    const value = normalizeAppearance({
      folders: [
        {
          id: "f",
          name: "Mixed",
          entries: [
            { id: "ok", name: "Good", target: "/channels/@me/1" },
            { id: "bad", name: "Evil", target: "https://evil.com/channels/@me/1" },
            { id: "worse", name: "Worse", target: "javascript:alert(1)" },
          ],
        },
      ],
    });
    assert.equal(value.folders[0]?.entries.length, 1);
    assert.equal(value.folders[0]?.entries[0]?.id, "ok");
  });

  test("falls back on an unknown tone rather than emitting an unstyled class", () => {
    const value = normalizeAppearance({ folders: [{ id: "f", name: "F", tone: "neon" }] });
    assert.equal(value.folders[0]?.tone, "violet");
  });

  test("de-duplicates ids so the UI can tell rows apart", () => {
    const value = normalizeAppearance({
      folders: [
        { id: "same", name: "One", entries: [] },
        { id: "same", name: "Two", entries: [] },
      ],
    });
    assert.equal(value.folders.length, 1);
    assert.equal(value.folders[0]?.name, "One");
  });

  test("rejects ids that could escape their character set", () => {
    const value = normalizeAppearance({ folders: [{ id: "../../etc", name: "F" }] });
    assert.match(value.folders[0]?.id ?? "", /^[A-Za-z0-9_-]+$/);
  });

  test("caps the folder count", () => {
    const value = normalizeAppearance({
      folders: Array.from({ length: MAX_FOLDERS + 8 }, (_, i) => ({
        id: `f${i}`,
        name: `F${i}`,
        entries: [],
      })),
    });
    assert.equal(value.folders.length, MAX_FOLDERS);
  });

  test("replaces an empty name instead of rendering a blank row", () => {
    const value = normalizeAppearance({ folders: [{ id: "f", name: "   ", entries: [] }] });
    assert.equal(value.folders[0]?.name, "Folder");
  });
});
