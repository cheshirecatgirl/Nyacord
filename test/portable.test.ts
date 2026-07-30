import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import { posix } from "node:path";

import { decidePortable, PORTABLE_DIR_NAME } from "../src/common/portable";

const base = {
  env: {} as Record<string, string | undefined>,
  execDir: "/opt/sable",
  markerExists: false,
  join: posix.join,
};

describe("portable detection", () => {
  test("defaults to the OS location", () => {
    const decision = decidePortable({ ...base, argv: [] });
    assert.equal(decision.portable, false);
    assert.equal(decision.dataDir, null);
  });

  test("a data directory beside the executable is enough", () => {
    const decision = decidePortable({ ...base, argv: [], markerExists: true });
    assert.equal(decision.portable, true);
    assert.equal(decision.reason, "marker");
    assert.equal(decision.dataDir, `/opt/sable/${PORTABLE_DIR_NAME}`);
  });

  test("--portable forces it without a marker", () => {
    const decision = decidePortable({ ...base, argv: ["--portable"] });
    assert.equal(decision.portable, true);
    assert.equal(decision.reason, "flag");
  });

  test("the environment variable works for launcher scripts", () => {
    for (const value of ["1", "true"]) {
      const decision = decidePortable({ ...base, argv: [], env: { SABLE_PORTABLE: value } });
      assert.equal(decision.portable, true, value);
      assert.equal(decision.reason, "env");
    }
    assert.equal(
      decidePortable({ ...base, argv: [], env: { SABLE_PORTABLE: "0" } }).portable,
      false,
    );
  });

  test("--data-dir wins over everything and takes both forms", () => {
    const equals = decidePortable({
      ...base,
      argv: ["--portable", "--data-dir=/mnt/stick/sable"],
      markerExists: true,
    });
    assert.equal(equals.dataDir, "/mnt/stick/sable");
    assert.equal(equals.reason, "explicit-path");

    const spaced = decidePortable({ ...base, argv: ["--data-dir", "/mnt/other"] });
    assert.equal(spaced.dataDir, "/mnt/other");
  });

  test("--data-dir followed by another flag is not treated as a value", () => {
    const decision = decidePortable({ ...base, argv: ["--data-dir", "--portable"] });
    assert.equal(decision.reason, "flag");
    assert.equal(decision.dataDir, `/opt/sable/${PORTABLE_DIR_NAME}`);
  });
});
