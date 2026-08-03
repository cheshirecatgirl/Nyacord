/**
 * The vault format: what a passphrase turns into, and what a sealed profile
 * looks like on disk.
 *
 * Pure, and depends only on `node:crypto`, so the format is testable without
 * Electron and without a real profile.
 *
 * Sealed, a profile is one AES-256-GCM ciphertext holding its cookies,
 * localStorage (Discord's token lives there), IndexedDB, cache and service
 * workers. The key exists only while the app is open.
 *
 * The limit is that Chromium reads and writes those files directly, so between
 * unlock and quit they are plaintext on disk. Nothing in a wrapper can change
 * it, and docs/SECURITY.md sets out what that does and does not cover.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

/**
 * Hand-wrapped, not `promisify`d: the callback form has two overloads
 * and `promisify` resolves to the one without an options argument, which is the
 * one that cannot express the cost parameters this whole file is about.
 */
function scrypt(
  passphrase: string,
  salt: Buffer,
  length: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(passphrase, salt, length, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export const VAULT_VERSION = 1;

const KEY_BYTES = 32;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
/** GCM writes its tag last, so unsealing has to seek to the end for it. */
export const VAULT_TAG_BYTES = 16;

/**
 * scrypt cost. logN 17 is 128 MiB and about a second, which puts the expense
 * on memory, the scarce resource on a guessing rig.
 *
 * Stored per vault, not hardcoded, so raising it later leaves older vaults
 * openable.
 */
export interface KdfParams {
  readonly logN: number;
  readonly r: number;
  readonly p: number;
}

export const DEFAULT_KDF: KdfParams = { logN: 17, r: 8, p: 1 };

/** Guards against a hand-edited sidecar asking for 16 GiB of scrypt memory. */
export function isUsableKdf(params: KdfParams): boolean {
  return (
    Number.isInteger(params.logN) &&
    params.logN >= 14 &&
    params.logN <= 20 &&
    Number.isInteger(params.r) &&
    params.r >= 1 &&
    params.r <= 32 &&
    Number.isInteger(params.p) &&
    params.p >= 1 &&
    params.p <= 16
  );
}

export async function deriveKey(
  passphrase: string,
  salt: Buffer,
  params: KdfParams = DEFAULT_KDF,
): Promise<Buffer> {
  if (!isUsableKdf(params)) throw new Error("unusable KDF parameters");
  const N = 2 ** params.logN;
  return scrypt(passphrase.normalize("NFKC"), salt, KEY_BYTES, {
    N,
    r: params.r,
    p: params.p,
    // Node's default cap is 32 MiB, which every parameter set worth using
    // exceeds. Sized from the parameters, not fixed, so raising
    // logN does not start throwing.
    maxmem: 256 * N * params.r,
  });
}

/**
 * A small ciphertext that proves a passphrase without unsealing anything.
 * Without it, every wrong attempt would cost a full pass over the archive and
 * still could not tell a bad passphrase from a corrupt vault.
 */
export interface Verifier {
  readonly iv: string;
  readonly ct: string;
  readonly tag: string;
}

const VERIFIER_PLAINTEXT = Buffer.from("nyacord.vault.v1");

export function makeVerifier(key: Buffer): Verifier {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(VERIFIER_PLAINTEXT), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function checkVerifier(key: Buffer, verifier: Verifier): boolean {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(verifier.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(verifier.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(verifier.ct, "base64")),
      decipher.final(),
    ]);
    return plain.length === VERIFIER_PLAINTEXT.length && timingSafeEqual(plain, VERIFIER_PLAINTEXT);
  } catch {
    // A wrong key fails the GCM tag check, which throws. That is the answer.
    return false;
  }
}

// --------------------------------------------------------------- the archive

/**
 * The sealed body is a flat sequence of entries. No directory tree in the
 * format; parents are created as needed on the way out.
 *
 *   u16   path length          (bytes, UTF-8)
 *   ...   path, POSIX separators, relative to the sealed root
 *   u8    kind: 0 directory, 1 file
 *   u32   mode, permission bits only
 *   u64   size (files only; 0 for directories)
 *   ...   contents
 */
export const ENTRY_DIR = 0;
export const ENTRY_FILE = 1;

export interface EntryHeader {
  readonly path: string;
  readonly kind: typeof ENTRY_DIR | typeof ENTRY_FILE;
  readonly mode: number;
  readonly size: number;
}

export const MAX_PATH_BYTES = 4096;

/** Bytes of fixed-width fields that follow the path. */
const ENTRY_TAIL = 1 + 4 + 8;

export function encodeEntry(entry: EntryHeader): Buffer {
  const path = Buffer.from(entry.path, "utf8");
  if (path.length === 0 || path.length > MAX_PATH_BYTES) {
    throw new Error(`refusing to seal an entry with an unusable path length: ${path.length}`);
  }

  const out = Buffer.alloc(2 + path.length + ENTRY_TAIL);
  out.writeUInt16BE(path.length, 0);
  path.copy(out, 2);
  out.writeUInt8(entry.kind, 2 + path.length);
  out.writeUInt32BE(entry.mode & 0o7777, 3 + path.length);
  out.writeBigUInt64BE(BigInt(entry.size), 7 + path.length);
  return out;
}

/**
 * Reads one entry header, or asks for more bytes. The decipher stream picks
 * its own chunk boundaries, so "not yet" is an ordinary answer, not an error.
 */
export function decodeEntry(buffer: Buffer): { entry: EntryHeader; read: number } | null {
  if (buffer.length < 2) return null;
  const pathLength = buffer.readUInt16BE(0);
  if (pathLength === 0 || pathLength > MAX_PATH_BYTES) {
    throw new Error("vault entry has an unusable path length");
  }

  const total = 2 + pathLength + ENTRY_TAIL;
  if (buffer.length < total) return null;

  const path = buffer.subarray(2, 2 + pathLength).toString("utf8");
  const kind = buffer.readUInt8(2 + pathLength);
  if (kind !== ENTRY_DIR && kind !== ENTRY_FILE) throw new Error("vault entry has an unknown kind");
  if (!isSafeEntryPath(path)) throw new Error(`vault entry has an unsafe path: ${path}`);

  const size = Number(buffer.readBigUInt64BE(7 + pathLength));
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("vault entry has an unusable size");
  if (kind === ENTRY_DIR && size !== 0) throw new Error("vault directory entry carries content");

  return {
    entry: { path, kind, mode: buffer.readUInt32BE(3 + pathLength) & 0o7777, size },
    read: total,
  };
}

/**
 * Paths out of a vault are untrusted; the file may not have been written by
 * us. Anything that could escape the extraction root is refused, not
 * sanitized. A sanitized traversal still lands a file nobody asked for.
 */
export function isSafeEntryPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_BYTES) return false;
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  if (path.includes("\0")) return false;
  if (path.includes("\\")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
