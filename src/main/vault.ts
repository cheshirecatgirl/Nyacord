import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  DEFAULT_KDF,
  ENTRY_DIR,
  ENTRY_FILE,
  IV_BYTES,
  SALT_BYTES,
  VAULT_TAG_BYTES,
  VAULT_VERSION,
  checkVerifier,
  decodeEntry,
  deriveKey,
  encodeEntry,
  isUsableKdf,
  makeVerifier,
  type EntryHeader,
  type KdfParams,
  type Verifier,
} from "../common/vault";
import { JsonStore } from "./store";

/**
 * The vault's public half: a salt, the KDF cost, a verifier ciphertext. No
 * secrets, so losing it to an attacker gives up nothing the sealed file would
 * not. Separate from the ciphertext so the app can tell "locked" from "no
 * vault" before asking for anything.
 */
export interface VaultMeta {
  version: number;
  salt: string;
  kdf: KdfParams;
  verifier: Verifier;
  /** True while the sealed file is the authoritative copy. */
  sealed: boolean;
  /** Consecutive wrong passphrases, kept across restarts so a relaunch is not a reset. */
  failures: number;
  /** Minutes of inactivity before the lock screen returns; 0 disables it. */
  autoLockMinutes: number;
  /**
   * Set when a previous run ended without sealing, so the UI can say that
   * plaintext was left on disk instead of quietly carrying on.
   */
  unsealedLeftBehind: boolean;
}

function defaultMeta(): VaultMeta {
  return {
    version: VAULT_VERSION,
    salt: "",
    kdf: DEFAULT_KDF,
    verifier: { iv: "", ct: "", tag: "" },
    sealed: false,
    failures: 0,
    autoLockMinutes: 0,
    unsealedLeftBehind: false,
  };
}

export type UnlockResult = { ok: true } | { ok: false; reason: "wrong-passphrase" | "corrupt" };

/**
 * Seals and opens a profile directory.
 *
 * The unit is the whole `session/Partitions` tree. One key, one file, and one
 * moment where plaintext is created or destroyed.
 */
export class ProfileVault {
  private readonly meta: JsonStore<VaultMeta>;
  private key: Buffer | null = null;

  constructor(
    /** `<dataDir>/session/Partitions`, the directory Chromium reads and writes. */
    private readonly plainDir: string,
    /** `<dataDir>/vault.bin`, present only while sealed. */
    private readonly sealedFile: string,
    metaFile: string,
  ) {
    this.meta = new JsonStore<VaultMeta>(metaFile, defaultMeta);
  }

  /** True once a passphrase has been set, whether or not it is currently open. */
  get enabled(): boolean {
    return this.meta.get().salt !== "";
  }

  /** True while the key is in memory and the profile data is usable. */
  get open(): boolean {
    return this.key !== null;
  }

  get sealedOnDisk(): boolean {
    return this.meta.get().sealed && existsSync(this.sealedFile);
  }

  get failures(): number {
    return this.meta.get().failures;
  }

  get autoLockMinutes(): number {
    return this.meta.get().autoLockMinutes;
  }

  get leftUnsealed(): boolean {
    return this.meta.get().unsealedLeftBehind;
  }

  setAutoLockMinutes(minutes: number): number {
    const clamped = Number.isFinite(minutes) ? Math.min(Math.max(Math.round(minutes), 0), 480) : 0;
    this.meta.update((draft) => {
      draft.autoLockMinutes = clamped;
    });
    return clamped;
  }

  // ------------------------------------------------------------------ enable

  /**
   * Turns the vault on. Sealing waits for quit: Chromium holds the profile
   * files open while it runs, and a snapshot taken underneath it would be
   * worse than no vault at all, being a backup that does not restore.
   */
  async enable(passphrase: string): Promise<void> {
    const salt = randomBytes(SALT_BYTES);
    const key = await deriveKey(passphrase, salt, DEFAULT_KDF);
    this.meta.replace({
      ...defaultMeta(),
      autoLockMinutes: this.meta.get().autoLockMinutes,
      salt: salt.toString("base64"),
      kdf: DEFAULT_KDF,
      verifier: makeVerifier(key),
    });
    this.meta.flush();
    this.key = key;
  }

  /**
   * Changes the passphrase. The data is plaintext at this point, so there is
   * nothing to re-encrypt; the next seal uses the new key. Which is also why
   * this only works while unlocked.
   */
  async changePassphrase(current: string, next: string): Promise<boolean> {
    if (!(await this.verify(current))) return false;
    await this.enable(next);
    return true;
  }

  /** Turns the vault off, leaving the profile data in place and unencrypted. */
  async disable(passphrase: string): Promise<boolean> {
    if (!(await this.verify(passphrase))) return false;
    if (existsSync(this.sealedFile)) {
      // Refuse to strip the vault while the only copy is still sealed; open it
      // first, or turning the vault off would delete the data.
      return false;
    }
    this.meta.replace({ ...defaultMeta(), autoLockMinutes: this.meta.get().autoLockMinutes });
    this.meta.flush();
    this.forgetKey();
    return true;
  }

  // ------------------------------------------------------------------ unlock

  private async verify(passphrase: string): Promise<boolean> {
    const meta = this.meta.get();
    if (!meta.salt || !isUsableKdf(meta.kdf)) return false;
    const key = await deriveKey(passphrase, Buffer.from(meta.salt, "base64"), meta.kdf);
    if (!checkVerifier(key, meta.verifier)) {
      key.fill(0);
      return false;
    }
    this.key = key;
    return true;
  }

  /**
   * Checks the passphrase and, if the data is sealed, opens it. Wrong attempts
   * are counted and the count survives a restart, so relaunching is not a way
   * around the delay.
   */
  async unlock(passphrase: string): Promise<UnlockResult> {
    if (!(await this.verify(passphrase))) {
      this.meta.update((draft) => {
        draft.failures += 1;
      });
      this.meta.flush();
      return { ok: false, reason: "wrong-passphrase" };
    }

    this.meta.update((draft) => {
      draft.failures = 0;
    });

    if (this.sealedOnDisk) {
      try {
        await this.openSealed();
      } catch (error) {
        console.error("[nya] could not open the vault:", error);
        this.forgetKey();
        return { ok: false, reason: "corrupt" };
      }
    }

    this.meta.update((draft) => {
      draft.sealed = false;
      draft.unsealedLeftBehind = false;
    });
    this.meta.flush();
    return { ok: true };
  }

  /**
   * Drops the key. The data stays on disk as it is, because Chromium still has
   * it open. This is a screen lock, not a re-seal; docs/SECURITY.md says so in
   * as many words.
   */
  forgetKey(): void {
    this.key?.fill(0);
    this.key = null;
  }

  // -------------------------------------------------------------- seal / open

  /**
   * Seals the profile tree and removes the plaintext. Called at quit, once the
   * views are gone.
   *
   * Written beside the destination and renamed into place; the plaintext goes
   * only after that rename succeeds. Any failure leaves the readable copy
   * alone. An unsealed profile is a privacy problem, a deleted one is a lost
   * account.
   */
  async seal(): Promise<boolean> {
    if (!this.key || !existsSync(this.plainDir)) return false;

    const temp = `${this.sealedFile}.partial`;
    try {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", this.key, iv);
      const out = createWriteStream(temp, { mode: 0o600 });

      out.write(iv);
      await pipeline(entries(this.plainDir), cipher, out, { end: false });
      await new Promise<void>((resolve, reject) => {
        out.end(cipher.getAuthTag(), () => resolve());
        out.on("error", reject);
      });

      renameSync(temp, this.sealedFile);
    } catch (error) {
      console.error("[nya] could not seal the vault:", error);
      rmSync(temp, { force: true });
      return false;
    }

    this.meta.update((draft) => {
      draft.sealed = true;
      draft.unsealedLeftBehind = false;
    });
    this.meta.flush();

    try {
      // Chromium may still hold handles here. Retries cover the ordinary case;
      // if it truly cannot be removed we record that instead of pretending.
      rmSync(this.plainDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.error("[nya] sealed, but could not remove the plaintext:", error);
      this.meta.update((draft) => {
        draft.unsealedLeftBehind = true;
      });
      this.meta.flush();
    }

    this.forgetKey();
    return true;
  }

  /**
   * Decrypts into a staging directory, verifies the tag, then moves it into
   * place. Streaming straight into the destination would write plaintext that
   * had not been authenticated yet, leaving a half-extracted profile behind
   * whenever a vault turned out to be truncated or tampered with.
   */
  private async openSealed(): Promise<void> {
    if (!this.key) throw new Error("no key");

    const size = statSync(this.sealedFile).size;
    if (size < IV_BYTES + VAULT_TAG_BYTES) throw new Error("sealed file is too small to be one");

    const handle = openSync(this.sealedFile, "r");
    let iv: Buffer;
    let tag: Buffer;
    try {
      iv = Buffer.alloc(IV_BYTES);
      readSync(handle, iv, 0, IV_BYTES, 0);
      tag = Buffer.alloc(VAULT_TAG_BYTES);
      readSync(handle, tag, 0, VAULT_TAG_BYTES, size - VAULT_TAG_BYTES);
    } finally {
      closeSync(handle);
    }

    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);

    const staging = `${this.plainDir}.opening`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true, mode: 0o700 });

    try {
      await pipeline(
        createReadStream(this.sealedFile, {
          start: IV_BYTES,
          end: size - VAULT_TAG_BYTES - 1,
        }),
        decipher,
        new EntrySink(staging),
      );
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }

    // The tag verified, so this is the real profile. Swap it in.
    rmSync(this.plainDir, { recursive: true, force: true });
    mkdirSync(dirname(this.plainDir), { recursive: true });
    renameSync(staging, this.plainDir);
    rmSync(this.sealedFile, { force: true });
  }

  /**
   * Called at startup when a vault exists. If plaintext is sitting next to a
   * sealed file, a previous run died before sealing; the plaintext is the newer
   * copy, so it wins and the stale sealed file is set aside, not used.
   */
  noteStartupState(): void {
    if (!this.enabled) return;
    const plaintextExists = existsSync(this.plainDir);
    if (plaintextExists && this.sealedOnDisk) {
      this.meta.update((draft) => {
        draft.unsealedLeftBehind = true;
      });
      this.meta.flush();
    }
  }
}

/**
 * Walks the tree depth-first, yielding a header for every entry and the bytes
 * of every file. A generator, not a list: a profile with a warm cache runs to
 * hundreds of megabytes and none of it should be resident.
 */
async function* entries(root: string): AsyncGenerator<Buffer> {
  async function* walk(dir: string): AsyncGenerator<Buffer> {
    const children = await readdir(dir, { withFileTypes: true });
    for (const child of children) {
      const absolute = join(dir, child.name);
      const path = relative(root, absolute).split(sep).join(posix.sep);

      if (child.isDirectory()) {
        const info = await stat(absolute);
        yield encodeEntry({ path, kind: ENTRY_DIR, mode: info.mode, size: 0 });
        yield* walk(absolute);
        continue;
      }

      // Symlinks and sockets are skipped, not followed. Chromium does not put
      // them in a partition, and following one would seal something outside
      // the tree.
      if (!child.isFile()) continue;

      const info = await stat(absolute);
      yield encodeEntry({ path, kind: ENTRY_FILE, mode: info.mode, size: info.size });

      let written = 0;
      for await (const chunk of createReadStream(absolute)) {
        const buffer = chunk as Buffer;
        // The size went into the header before the read began. A file being
        // appended to underneath us gets trimmed or padded; letting it run
        // long would desynchronize every entry after it.
        const room = info.size - written;
        if (room <= 0) break;
        yield buffer.length > room ? buffer.subarray(0, room) : buffer;
        written += Math.min(buffer.length, room);
      }
      if (written < info.size) yield Buffer.alloc(info.size - written);
    }
  }

  yield* walk(root);
}

/** Rebuilds the tree from the decrypted byte stream. */
class EntrySink extends Writable {
  private buffered: Buffer = Buffer.alloc(0);
  private remaining = 0;
  private file: import("node:fs").WriteStream | null = null;

  constructor(private readonly root: string) {
    super();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    this.drain().then(
      () => callback(),
      (error: Error) => callback(error),
    );
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.remaining > 0) {
      callback(new Error("vault ended in the middle of a file"));
      return;
    }
    this.closeFile().then(
      () => callback(),
      (error: Error) => callback(error),
    );
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.remaining > 0) {
        const take = Math.min(this.remaining, this.buffered.length);
        if (take === 0) return;
        await this.writeFileChunk(this.buffered.subarray(0, take));
        this.buffered = this.buffered.subarray(take);
        this.remaining -= take;
        if (this.remaining === 0) await this.closeFile();
        continue;
      }

      const decoded = decodeEntry(this.buffered);
      if (!decoded) return;
      this.buffered = this.buffered.subarray(decoded.read);
      await this.begin(decoded.entry);
    }
  }

  private async begin(entry: EntryHeader): Promise<void> {
    const target = join(this.root, ...entry.path.split(posix.sep));

    if (entry.kind === ENTRY_DIR) {
      await mkdir(target, { recursive: true, mode: 0o700 });
      return;
    }

    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    if (entry.size === 0) {
      await writeFile(target, "", { mode: 0o600 });
      return;
    }

    this.remaining = entry.size;
    this.file = createWriteStream(target, { mode: 0o600 });
  }

  private writeFileChunk(chunk: Buffer): Promise<void> {
    const file = this.file;
    if (!file) return Promise.reject(new Error("vault has content outside any file"));
    return new Promise((resolve, reject) => {
      file.write(chunk, (error) => (error ? reject(error) : resolve()));
    });
  }

  private closeFile(): Promise<void> {
    const file = this.file;
    this.file = null;
    if (!file) return Promise.resolve();
    return new Promise((resolve, reject) => {
      file.end(() => resolve());
      file.on("error", reject);
    });
  }
}
