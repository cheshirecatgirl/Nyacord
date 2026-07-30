import { strict as assert } from "node:assert";
import { test, describe } from "node:test";

import {
  PERMISSION_KEYS,
  balancedPolicy,
  normalizePolicy,
  paranoidPolicy,
  presetPolicy,
  strictPolicy,
} from "../src/common/policy";

describe("presets", () => {
  test("get stricter monotonically on the settings that matter", () => {
    const b = balancedPolicy();
    const s = strictPolicy();
    const p = paranoidPolicy();

    assert.equal(b.ghost.enabled, false);
    assert.equal(s.ghost.enabled, true);
    assert.equal(p.ghost.enabled, true);

    assert.equal(b.blockThirdPartyMedia, false);
    assert.equal(p.blockThirdPartyMedia, true);

    assert.equal(b.webrtc, "public_interface_only");
    assert.equal(p.webrtc, "disable_non_proxied_udp");
  });

  test("never grant a dangerous capability implicitly", () => {
    for (const name of ["balanced", "strict", "paranoid"] as const) {
      const policy = presetPolicy(name);
      for (const key of ["hid", "serial", "usb", "geolocation", "bluetooth", "idle-detection"] as const) {
        assert.notEqual(policy.permissions[key], "allow", `${name}/${key}`);
      }
    }
  });

  test("default the spellchecker off so no dictionary is fetched", () => {
    assert.equal(balancedPolicy().spellcheck, false);
  });
});

describe("normalizePolicy", () => {
  test("returns a usable policy from garbage", () => {
    for (const input of [null, undefined, 42, "nope", [], { preset: "wat" }]) {
      const policy = normalizePolicy(input);
      assert.equal(typeof policy.blockTelemetry, "boolean");
      assert.equal(PERMISSION_KEYS.every((key) => key in policy.permissions), true);
    }
  });

  test("keeps recognised overrides", () => {
    const policy = normalizePolicy({
      preset: "strict",
      blockThirdPartyMedia: true,
      ghost: { suppressTyping: false },
      permissions: { media: "allow" },
      webrtc: "default",
    });
    assert.equal(policy.blockThirdPartyMedia, true);
    assert.equal(policy.ghost.suppressTyping, false);
    assert.equal(policy.ghost.enabled, true, "inherited from the strict base");
    assert.equal(policy.permissions.media, "allow");
    assert.equal(policy.webrtc, "default");
  });

  test("drops values outside the allowed set instead of trusting them", () => {
    const policy = normalizePolicy({
      permissions: { media: "definitely-allow", usb: "allow" },
      webrtc: "off",
      blockTelemetry: "yes",
    });
    assert.equal(policy.permissions.media, balancedPolicy().permissions.media);
    assert.equal(policy.permissions.usb, "allow", "a valid value is still honoured");
    assert.equal(policy.webrtc, balancedPolicy().webrtc);
    assert.equal(policy.blockTelemetry, true, "non-boolean falls back to the base");
  });

  test("ignores unknown keys entirely", () => {
    const policy = normalizePolicy({ evil: true, __proto__: { polluted: true } });
    assert.equal((policy as unknown as Record<string, unknown>)["evil"], undefined);
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  });
});
