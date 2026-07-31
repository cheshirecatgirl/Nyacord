import { strict as assert } from "node:assert";
import { test, describe } from "node:test";

import { balancedPolicy, paranoidPolicy, strictPolicy, type PrivacyPolicy } from "../src/common/policy";
import { classify } from "../src/common/rules";

const xhr = (url: string, method = "GET") => ({ url, method, resourceType: "xhr" });
const image = (url: string) => ({ url, method: "GET", resourceType: "image" });

function ghostOn(): PrivacyPolicy {
  const policy = balancedPolicy();
  policy.ghost = {
    enabled: true,
    suppressTyping: true,
    suppressReadReceipts: true,
    suppressCallReports: true,
  };
  return policy;
}

describe("telemetry", () => {
  const policy = balancedPolicy();

  test("blocks the science endpoint on every channel", () => {
    for (const host of ["discord.com", "ptb.discord.com", "canary.discord.com"]) {
      const verdict = classify(xhr(`https://${host}/api/v9/science`, "POST"), policy);
      assert.equal(verdict.blocked, true, host);
      assert.equal(verdict.category, "telemetry");
    }
  });

  test("blocks the version-less form", () => {
    assert.equal(classify(xhr("https://discord.com/api/science", "POST"), policy).blocked, true);
  });

  test("leaves the gateway and ordinary API calls alone", () => {
    assert.equal(classify(xhr("wss://gateway.discord.gg/?v=10"), policy).blocked, false);
    assert.equal(
      classify(xhr("https://discord.com/api/v9/users/@me/channels"), policy).blocked,
      false,
    );
    assert.equal(
      classify(xhr("https://discord.com/api/v9/channels/1/messages", "POST"), policy).blocked,
      false,
    );
  });

  test("does not block a path that merely contains the word", () => {
    assert.equal(
      classify(xhr("https://discord.com/api/v9/guilds/1/science-club"), policy).blocked,
      false,
    );
  });
});

describe("error reporting", () => {
  const policy = balancedPolicy();

  test("blocks sentry ingest", () => {
    assert.equal(classify(xhr("https://o1.ingest.sentry.io/api/2/envelope/", "POST"), policy).blocked, true);
  });

  test("blocks Discord's error-reporting path", () => {
    assert.equal(
      classify(xhr("https://discord.com/error-reporting-proxy/foo", "POST"), policy).blocked,
      true,
    );
  });
});

describe("ghost mode", () => {
  test("is inert until enabled", () => {
    const verdict = classify(
      xhr("https://discord.com/api/v9/channels/12345/typing", "POST"),
      balancedPolicy(),
    );
    assert.equal(verdict.blocked, false);
  });

  test("suppresses typing", () => {
    const verdict = classify(
      xhr("https://discord.com/api/v9/channels/12345/typing", "POST"),
      ghostOn(),
    );
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.category, "ghost-typing");
  });

  test("suppresses every ack shape", () => {
    const policy = ghostOn();
    const urls = [
      "https://discord.com/api/v9/channels/1/messages/2/ack",
      "https://discord.com/api/v9/channels/1/ack",
      "https://discord.com/api/v9/guilds/1/ack",
      "https://discord.com/api/v9/read-states/ack-bulk",
    ];
    for (const url of urls) {
      const verdict = classify(xhr(url, "POST"), policy);
      assert.equal(verdict.blocked, true, url);
      assert.equal(verdict.category, "ghost-read-receipt", url);
    }
  });

  test("only suppresses acks on POST, so reads still work", () => {
    const verdict = classify(
      xhr("https://discord.com/api/v9/channels/1/messages/2/ack", "GET"),
      ghostOn(),
    );
    assert.equal(verdict.blocked, false);
  });

  test("does not touch message sending", () => {
    assert.equal(
      classify(xhr("https://discord.com/api/v9/channels/1/messages", "POST"), ghostOn()).blocked,
      false,
    );
  });
});

describe("host matching", () => {
  const policy = strictPolicy();

  test("a lookalike domain is not treated as Discord", () => {
    // `blockActivities` is on in strict, and a lookalike must not inherit the
    // Discord-owned exemption anywhere else either.
    const verdict = classify(xhr("https://evil-discord.com/api/v9/science", "POST"), policy);
    assert.equal(verdict.blocked, false, "not our traffic to block as telemetry");
  });

  test("subdomains of discordsays are activities", () => {
    assert.equal(classify(xhr("https://1234.discordsays.com/index.html"), policy).category, "activity");
  });
});

describe("third-party media", () => {
  test("balanced allows off-platform images", () => {
    assert.equal(classify(image("https://example.com/cat.png"), balancedPolicy()).blocked, false);
  });

  test("paranoid blocks them but keeps Discord's own CDN", () => {
    const policy = paranoidPolicy();
    assert.equal(classify(image("https://example.com/cat.png"), policy).blocked, true);
    assert.equal(
      classify(image("https://cdn.discordapp.com/attachments/1/2/cat.png"), policy).blocked,
      false,
    );
    assert.equal(
      classify(image("https://media.discordapp.net/attachments/1/2/cat.png"), policy).blocked,
      false,
    );
  });

  test("paranoid does not block off-platform XHR, only fetched media", () => {
    assert.equal(classify(xhr("https://example.com/api"), paranoidPolicy()).blocked, false);
  });
});

describe("non-network schemes", () => {
  test("are never classified", () => {
    const policy = paranoidPolicy();
    for (const url of ["devtools://devtools/bundled/x.js", "blob:https://discord.com/abc", "data:text/html,x"]) {
      assert.equal(classify(xhr(url), policy).blocked, false, url);
    }
  });

  test("a malformed URL is allowed, not thrown on", () => {
    assert.equal(classify(xhr("not a url"), paranoidPolicy()).blocked, false);
  });
});
