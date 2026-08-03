/**
 * Passphrase judgements shared by the UI and the main process.
 *
 * Kept out of `common/vault.ts` because that module imports `node:crypto` and
 * the settings panel is a browser bundle.
 */

export type PassphraseVerdict = "empty" | "weak" | "fair" | "strong";

/**
 * A sealed vault is guessed at offline, with no app in the way and no lockout,
 * so length is the only thing that buys time. Digits alone never pass.
 */
export function ratePassphrase(passphrase: string): PassphraseVerdict {
  if (passphrase.length === 0) return "empty";

  const classes =
    Number(/[a-z]/.test(passphrase)) +
    Number(/[A-Z]/.test(passphrase)) +
    Number(/[0-9]/.test(passphrase)) +
    Number(/[^a-zA-Z0-9]/.test(passphrase));

  if (/^[0-9]+$/.test(passphrase) || passphrase.length < 10) return "weak";
  if (passphrase.length >= 16 || (passphrase.length >= 12 && classes >= 3)) return "strong";
  return "fair";
}

/** Delay before the running app accepts another attempt. Caps at five minutes. */
export function lockoutMs(failures: number): number {
  if (failures < 3) return 0;
  return Math.min(2 ** (failures - 2) * 1000, 5 * 60 * 1000);
}
