import { strict as assert } from "node:assert";
import { test, describe } from "node:test";

import {
  chromeMajor,
  clientHintBrands,
  clientHintPlatform,
  minimizedReferrer,
  sanitizeUserAgent,
} from "../src/common/ua";
import { partitionFor } from "../src/common/profile";

const ELECTRON_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Sable/0.1.0 Chrome/138.0.7204.100 Electron/43.2.0 Safari/537.36";

describe("user agent", () => {
  test("removes every token that identifies the shell", () => {
    const sanitized = sanitizeUserAgent(ELECTRON_UA);
    assert.equal(sanitized.includes("Electron"), false);
    assert.equal(sanitized.includes("Sable"), false);
    assert.equal(sanitized.includes("Chrome/138.0.7204.100"), true);
    assert.equal(sanitized.includes("  "), false, "no double spaces left behind");
  });

  test("keeps the platform truthful", () => {
    // Lying about the OS is more identifying than admitting it, because a
    // dozen other signals still say Linux.
    assert.equal(sanitizeUserAgent(ELECTRON_UA).includes("X11; Linux x86_64"), true);
  });

  test("is idempotent", () => {
    const once = sanitizeUserAgent(ELECTRON_UA);
    assert.equal(sanitizeUserAgent(once), once);
  });
});

describe("client hints", () => {
  test("agree with the sanitized user agent's major version", () => {
    assert.equal(chromeMajor("138.0.7204.100"), "138");
    const brands = clientHintBrands("138.0.7204.100");
    assert.equal(brands.includes('"Chromium";v="138"'), true);
    assert.equal(brands.includes("Electron"), false);
    assert.equal(brands.includes("Not)A;Brand"), true, "real Chrome always sends a GREASE brand");
  });

  test("map node platforms to Chromium spellings", () => {
    assert.equal(clientHintPlatform("win32"), '"Windows"');
    assert.equal(clientHintPlatform("darwin"), '"macOS"');
    assert.equal(clientHintPlatform("linux"), '"Linux"');
    assert.equal(clientHintPlatform("sunos"), '"Unknown"');
  });

  test("survive a malformed version rather than emitting NaN", () => {
    assert.equal(chromeMajor(""), "0");
    assert.equal(chromeMajor("abc"), "0");
  });
});

describe("referrer minimization", () => {
  test("keeps only the origin same-site", () => {
    assert.equal(
      minimizedReferrer("https://discord.com/api/v9/x", "https://discord.com/channels/1/2"),
      "https://discord.com/",
    );
  });

  test("sends nothing cross-origin", () => {
    assert.equal(minimizedReferrer("https://example.com/x", "https://discord.com/channels/1/2"), null);
    assert.equal(
      minimizedReferrer("https://ptb.discord.com/x", "https://discord.com/y"),
      null,
      "channels are separate origins",
    );
  });
});

describe("session partitions", () => {
  test("persistent profiles persist and ephemeral ones do not", () => {
    assert.equal(partitionFor({ id: "abc123", ephemeral: false }), "persist:sable-abc123");
    assert.equal(partitionFor({ id: "abc123", ephemeral: true }), "sable-eph-abc123");
  });

  test("a hand-edited id cannot escape the namespace", () => {
    assert.equal(partitionFor({ id: "../../etc", ephemeral: false }), "persist:sable-etc");
    assert.equal(partitionFor({ id: "persist:evil", ephemeral: true }), "sable-eph-persistevil");
  });
});
