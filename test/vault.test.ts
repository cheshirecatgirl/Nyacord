import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_KDF,
  ENTRY_DIR,
  ENTRY_FILE,
  checkVerifier,
  decodeEntry,
  deriveKey,
  encodeEntry,
  isSafeEntryPath,
  isUsableKdf,
  makeVerifier,
} from "../src/common/vault";
import { lockoutMs, ratePassphrase } from "../src/common/passphrase";
import { ProfileVault } from "../src/main/vault";

/**
 * A cheap KDF for the round-trip tests. The real cost is 128 MiB and about a
 * second, which is correct for a vault and wrong for a test suite that derives
 * a key a dozen times.
 */
const FAST = { logN: 14, r: 8, p: 1 };

describe("passphrase rating", () => {
  test("refuses a numeric passcode however long", () => {
    // The point the UI has to make: a vault is an offline target, so a PIN is
    // guessable no matter what the KDF costs.
    assert.equal(ratePassphrase("123456"), "weak");
    assert.equal(ratePassphrase("9184726351902847"), "weak");
  });

  test("length is what earns a good rating", () => {
    assert.equal(ratePassphrase("short1!"), "weak");
    assert.equal(ratePassphrase("correct-horse"), "fair");
    assert.equal(ratePassphrase("correct horse battery staple"), "strong");
    assert.equal(ratePassphrase("Tr0ub4dor&3x"), "strong");
  });

  test("an empty passphrase is its own answer", () => {
    assert.equal(ratePassphrase(""), "empty");
  });
});

describe("lockout", () => {
  test("does not punish an ordinary typo", () => {
    assert.equal(lockoutMs(0), 0);
    assert.equal(lockoutMs(2), 0);
  });

  test("backs off and then stops growing", () => {
    assert.equal(lockoutMs(3), 2_000);
    assert.equal(lockoutMs(4), 4_000);
    assert.equal(lockoutMs(99), 5 * 60 * 1000);
  });
});

describe("key derivation", () => {
  test("the same passphrase and salt give the same key", async () => {
    const salt = randomBytes(16);
    const a = await deriveKey("correct horse battery staple", salt, FAST);
    const b = await deriveKey("correct horse battery staple", salt, FAST);
    assert.equal(a.length, 32);
    assert.deepEqual(a, b);
  });

  test("a different salt gives a different key", async () => {
    const a = await deriveKey("same passphrase", randomBytes(16), FAST);
    const b = await deriveKey("same passphrase", randomBytes(16), FAST);
    assert.notDeepEqual(a, b);
  });

  test("refuses parameters a hand-edited sidecar could ask for", () => {
    assert.equal(isUsableKdf(DEFAULT_KDF), true);
    // 2^40 would try to allocate more memory than the machine has and hang.
    assert.equal(isUsableKdf({ logN: 40, r: 8, p: 1 }), false);
    assert.equal(isUsableKdf({ logN: 4, r: 8, p: 1 }), false);
    assert.equal(isUsableKdf({ logN: 17, r: 0, p: 1 }), false);
  });
});

describe("verifier", () => {
  test("accepts the right key and rejects a wrong one", async () => {
    const salt = randomBytes(16);
    const key = await deriveKey("open sesame please", salt, FAST);
    const verifier = makeVerifier(key);

    assert.equal(checkVerifier(key, verifier), true);
    assert.equal(checkVerifier(await deriveKey("not it at all", salt, FAST), verifier), false);
  });

  test("a tampered verifier fails rather than throwing", () => {
    const key = randomBytes(32);
    const verifier = makeVerifier(key);
    const flipped = { ...verifier, ct: Buffer.from(randomBytes(16)).toString("base64") };
    assert.equal(checkVerifier(key, flipped), false);
  });
});

describe("entry framing", () => {
  test("round-trips a header", () => {
    const entry = { path: "Local Storage/leveldb/000003.log", kind: ENTRY_FILE, mode: 0o600, size: 4096 } as const;
    const decoded = decodeEntry(encodeEntry(entry));
    assert.ok(decoded);
    assert.deepEqual(decoded.entry, entry);
    assert.equal(decoded.read, encodeEntry(entry).length);
  });

  test("asks for more bytes instead of failing on a split header", () => {
    // The decipher stream picks its own chunk boundaries, so a partial header
    // has to be an ordinary answer rather than an error.
    const buffer = encodeEntry({ path: "a/b/c", kind: ENTRY_DIR, mode: 0o700, size: 0 });
    assert.equal(decodeEntry(buffer.subarray(0, 3)), null);
    assert.ok(decodeEntry(buffer));
  });

  test("refuses paths that would escape the extraction root", () => {
    // The vault file is untrusted input: it may not have been written by us.
    assert.equal(isSafeEntryPath("../../etc/passwd"), false);
    assert.equal(isSafeEntryPath("/etc/passwd"), false);
    assert.equal(isSafeEntryPath("C:\\Windows\\System32"), false);
    assert.equal(isSafeEntryPath("a\\..\\b"), false);
    assert.equal(isSafeEntryPath("a/./b"), false);
    assert.equal(isSafeEntryPath("a//b"), false);
    assert.equal(isSafeEntryPath("Cache/Cache_Data/index"), true);
  });

  test("a directory entry may not carry content", () => {
    const bad = encodeEntry({ path: "d", kind: ENTRY_DIR, mode: 0o700, size: 10 });
    assert.throws(() => decodeEntry(bad), /carries content/);
  });
});

// ------------------------------------------------------------- the real thing

/** Builds a small tree that looks like a Chromium partition. */
function seedProfile(root: string): void {
  mkdirSync(join(root, "nya-abc", "Local Storage", "leveldb"), { recursive: true });
  mkdirSync(join(root, "nya-abc", "Cache"), { recursive: true });
  writeFileSync(join(root, "nya-abc", "Local Storage", "leveldb", "000003.log"), "token-ish bytes");
  writeFileSync(join(root, "nya-abc", "Cache", "data_0"), randomBytes(64 * 1024));
  writeFileSync(join(root, "nya-abc", "Cache", "empty"), "");
  writeFileSync(join(root, "Cookies"), "cookie jar");
}

function makeVault(base: string): ProfileVault {
  return new ProfileVault(
    join(base, "Partitions"),
    join(base, "vault.bin"),
    join(base, "vault.json"),
  );
}

describe("sealing a profile", () => {
  test("seals, removes the plaintext, and gives it back intact", async () => {
    const base = mkdtempSync(join(tmpdir(), "nya-vault-"));
    try {
      seedProfile(join(base, "Partitions"));
      const before = readFileSync(join(base, "Partitions", "nya-abc", "Cache", "data_0"));

      const vault = makeVault(base);
      await vault.enable("correct horse battery staple");
      assert.equal(vault.enabled, true);
      assert.equal(vault.open, true);

      assert.equal(await vault.seal(), true);
      // The whole point: after sealing there is a ciphertext and no profile.
      assert.equal(existsSync(join(base, "vault.bin")), true);
      assert.equal(existsSync(join(base, "Partitions")), false);
      assert.equal(vault.open, false, "the key is dropped once the data is sealed");

      // Nothing recognisable survives in the sealed file.
      const sealed = readFileSync(join(base, "vault.bin"));
      assert.equal(sealed.includes(Buffer.from("token-ish bytes")), false);
      assert.equal(sealed.includes(Buffer.from("cookie jar")), false);

      const reopened = makeVault(base);
      assert.equal(reopened.sealedOnDisk, true);
      assert.deepEqual(await reopened.unlock("correct horse battery staple"), { ok: true });

      assert.equal(
        readFileSync(join(base, "Partitions", "nya-abc", "Local Storage", "leveldb", "000003.log"), "utf8"),
        "token-ish bytes",
      );
      assert.deepEqual(readFileSync(join(base, "Partitions", "nya-abc", "Cache", "data_0")), before);
      assert.equal(readFileSync(join(base, "Partitions", "Cookies"), "utf8"), "cookie jar");
      assert.equal(readFileSync(join(base, "Partitions", "nya-abc", "Cache", "empty"), "utf8"), "");
      // The sealed copy goes once it has been opened, so there is one truth.
      assert.equal(existsSync(join(base, "vault.bin")), false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a wrong passphrase is refused and counted", async () => {
    const base = mkdtempSync(join(tmpdir(), "nya-vault-"));
    try {
      seedProfile(join(base, "Partitions"));
      const vault = makeVault(base);
      await vault.enable("correct horse battery staple");
      await vault.seal();

      const reopened = makeVault(base);
      const result = await reopened.unlock("wrong one entirely");
      assert.deepEqual(result, { ok: false, reason: "wrong-passphrase" });
      assert.equal(reopened.open, false);
      assert.equal(reopened.failures, 1);
      // Refusing must not touch the sealed data.
      assert.equal(existsSync(join(base, "vault.bin")), true);
      assert.equal(existsSync(join(base, "Partitions")), false);

      // The count survives a restart, so relaunching is not a way around it.
      assert.equal(makeVault(base).failures, 1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a tampered vault is refused, not half-extracted", async () => {
    const base = mkdtempSync(join(tmpdir(), "nya-vault-"));
    try {
      seedProfile(join(base, "Partitions"));
      const vault = makeVault(base);
      await vault.enable("correct horse battery staple");
      await vault.seal();

      // Flip a byte in the middle of the ciphertext.
      const sealed = readFileSync(join(base, "vault.bin"));
      const at = Math.floor(sealed.length / 2);
      sealed.writeUInt8(sealed.readUInt8(at) ^ 0xff, at);
      writeFileSync(join(base, "vault.bin"), sealed);

      const reopened = makeVault(base);
      const result = await reopened.unlock("correct horse battery staple");
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.reason, "corrupt");
      // Staging is what buys this: nothing unauthenticated reaches the profile.
      assert.equal(existsSync(join(base, "Partitions")), false);
      assert.equal(existsSync(join(base, "Partitions.opening")), false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("changing the passphrase changes what opens it", async () => {
    const base = mkdtempSync(join(tmpdir(), "nya-vault-"));
    try {
      seedProfile(join(base, "Partitions"));
      const vault = makeVault(base);
      await vault.enable("correct horse battery staple");

      assert.equal(await vault.changePassphrase("wrong", "another long passphrase"), false);
      assert.equal(
        await vault.changePassphrase("correct horse battery staple", "another long passphrase"),
        true,
      );
      await vault.seal();

      const reopened = makeVault(base);
      assert.equal((await reopened.unlock("correct horse battery staple")).ok, false);
      assert.equal((await makeVault(base).unlock("another long passphrase")).ok, true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("refuses to be turned off while the data is still sealed", async () => {
    // Otherwise "turn off the vault" would silently mean "delete my account".
    const base = mkdtempSync(join(tmpdir(), "nya-vault-"));
    try {
      seedProfile(join(base, "Partitions"));
      const vault = makeVault(base);
      await vault.enable("correct horse battery staple");
      await vault.seal();

      const reopened = makeVault(base);
      assert.equal(await reopened.disable("correct horse battery staple"), false);
      assert.equal(reopened.enabled, true);
      assert.equal(existsSync(join(base, "vault.bin")), true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("notices when a previous run left plaintext behind", async () => {
    const base = mkdtempSync(join(tmpdir(), "nya-vault-"));
    try {
      seedProfile(join(base, "Partitions"));
      const vault = makeVault(base);
      await vault.enable("correct horse battery staple");
      await vault.seal();

      // Simulate a crash: the sealed file is there and so is a profile tree.
      seedProfile(join(base, "Partitions"));

      const reopened = makeVault(base);
      reopened.noteStartupState();
      assert.equal(reopened.leftUnsealed, true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
