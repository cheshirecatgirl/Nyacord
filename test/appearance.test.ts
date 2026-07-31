import { strict as assert } from "node:assert";
import { test, describe } from "node:test";

import {
  BUILTIN_FOLDERS,
  MAX_FOLDERS,
  defaultAppearance,
  folderTabs,
  isDirectMessageTarget,
  isReservedFolderId,
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
    assert.equal(value.activeFolder, "dms");
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
          entries: [{ id: "a", name: "Standup", target: "https://discord.com/channels/1/2" }],
        },
      ],
    });
    assert.equal(value.layout, "classic");
    assert.equal(value.folders.length, 1);
    assert.equal(value.folders[0]?.tone, "green");
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

describe("the folder switcher", () => {
  test("always leads with the two built-in tabs", () => {
    const tabs = folderTabs(defaultAppearance());
    assert.deepEqual(
      tabs.map((tab) => tab.id),
      ["dms", "servers"],
    );
    assert.equal(
      tabs.every((tab) => tab.builtin),
      true,
    );
  });

  test("appends user folders after the built-ins, in order", () => {
    const config = normalizeAppearance({
      folders: [
        { id: "work", name: "Work", tone: "green", entries: [] },
        {
          id: "games",
          name: "Games",
          tone: "amber",
          entries: [{ id: "a", name: "Raid", target: "/channels/1/2" }],
        },
      ],
    });
    const tabs = folderTabs(config);
    assert.deepEqual(
      tabs.map((tab) => tab.id),
      ["dms", "servers", "work", "games"],
    );
    assert.deepEqual(
      tabs.map((tab) => tab.label),
      ["DMs", "Servers", "Work", "Games"],
    );
  });

  test("reports a count only for folders whose contents we own", () => {
    // The built-in groups are filled by Discord, so a count there would be a
    // number we do not have rather than a genuine zero.
    const config = normalizeAppearance({
      folders: [
        {
          id: "work",
          name: "Work",
          entries: [{ id: "a", name: "Standup", target: "/channels/1/2" }],
        },
      ],
    });
    const tabs = folderTabs(config);
    assert.equal(tabs[0]?.count, -1);
    assert.equal(tabs[1]?.count, -1);
    assert.equal(tabs[2]?.count, 1);
  });

  test("remembers the active tab", () => {
    const value = normalizeAppearance({
      folders: [{ id: "work", name: "Work", entries: [] }],
      activeFolder: "work",
    });
    assert.equal(value.activeFolder, "work");
  });

  test("falls back when the remembered tab no longer exists", () => {
    // Deleting a folder, or moving the config between machines, must not leave
    // the switcher pointing at nothing.
    assert.equal(normalizeAppearance({ activeFolder: "deleted" }).activeFolder, "dms");
    assert.equal(normalizeAppearance({ activeFolder: 42 }).activeFolder, "dms");
    assert.equal(normalizeAppearance({ activeFolder: "servers" }).activeFolder, "servers");
  });

  test("stops a user folder from impersonating a built-in tab", () => {
    for (const builtin of BUILTIN_FOLDERS) {
      const value = normalizeAppearance({
        folders: [{ id: builtin.id, name: "Impostor", entries: [] }],
      });
      assert.notEqual(value.folders[0]?.id, builtin.id);
      assert.equal(isReservedFolderId(value.folders[0]?.id ?? ""), false);
      // The switcher must still show exactly one tab per id.
      const ids = folderTabs(value).map((tab) => tab.id);
      assert.equal(new Set(ids).size, ids.length);
    }
  });
});
