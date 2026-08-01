import { strict as assert } from "node:assert";
import { test, describe } from "node:test";

import {
  composeLayoutCss,
  isEmptyStylesheet,
  parseLayoutStylesheet,
} from "../src/common/stylesheet";

const SHEET = `
nav { padding-top: 40px; }

/* [dms] */
nav[class*="guilds_"] { display: none; }

/* [servers] */
nav[class*="guilds_"] { width: 240px; }
`;

describe("parseLayoutStylesheet", () => {
  test("treats anything before the first marker as shared", () => {
    const sheet = parseLayoutStylesheet(SHEET);
    assert.equal(sheet.shared, "nav { padding-top: 40px; }");
  });

  test("splits the two sides", () => {
    const sheet = parseLayoutStylesheet(SHEET);
    assert.match(sheet.dms, /display: none/);
    assert.match(sheet.servers, /width: 240px/);
    assert.equal(sheet.dms.includes("240px"), false);
  });

  test("accepts an explicit shared marker anywhere", () => {
    const sheet = parseLayoutStylesheet(`
/* [dms] */
a { color: red; }
/* [shared] */
b { color: blue; }
`);
    assert.match(sheet.dms, /color: red/);
    assert.match(sheet.shared, /color: blue/);
  });

  test("merges repeated sections instead of dropping the earlier one", () => {
    const sheet = parseLayoutStylesheet(`
/* [servers] */
a { color: red; }
/* [dms] */
b { color: blue; }
/* [servers] */
c { color: green; }
`);
    assert.match(sheet.servers, /color: red/);
    assert.match(sheet.servers, /color: green/);
  });

  test("ignores a comment that only looks like a marker", () => {
    const sheet = parseLayoutStylesheet("a { color: red; } /* [dms] not a marker */");
    assert.equal(sheet.dms, "");
    assert.match(sheet.shared, /color: red/);
  });

  test("survives an empty file", () => {
    const sheet = parseLayoutStylesheet("");
    assert.equal(isEmptyStylesheet(sheet), true);
  });
});

describe("composeLayoutCss", () => {
  test("puts shared rules with the side that is showing", () => {
    const sheet = parseLayoutStylesheet(SHEET);

    const dms = composeLayoutCss(sheet, "dms");
    assert.match(dms, /padding-top: 40px/);
    assert.match(dms, /display: none/);
    assert.equal(dms.includes("240px"), false);

    const servers = composeLayoutCss(sheet, "servers");
    assert.match(servers, /padding-top: 40px/);
    assert.match(servers, /width: 240px/);
    assert.equal(servers.includes("display: none"), false);
  });

  test("returns nothing at all for an empty sheet, so nothing is injected", () => {
    assert.equal(composeLayoutCss(parseLayoutStylesheet(""), "dms"), "");
  });
});
