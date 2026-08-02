/**
 * Passphrase judgements that both the UI and the main process need.
 *
 * Separate from `common/vault.ts` on purpose. That module reaches for
 * `node:crypto`, and the settings panel is a browser bundle: importing the
 * strength meter from there would drag the whole cipher layer into a renderer,
 * which does not build and should not be made to.
 *
 * Nothing here touches a key. These are opinions about a string.
 */

export type PassphraseVerdict = "empty" | "weak" | "fair" | "strong";

/**
 * A deliberately blunt strength estimate, used to warn rather than to score.
 *
 * The point it exists to make is specific: a vault is an *offline* target. An
 * attacker holding the sealed file guesses as fast as their hardware allows,
 * with no app in the way and no lockout to stop them, so a short numeric
 * passcode is not saved by any amount of KDF cost. Length is what buys time
 * here, which is why it dominates and why digits alone never pass.
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

/**
 * How long to refuse another attempt after `failures` wrong ones.
 *
 * This only slows down someone typing at the running app. It does nothing
 * against the sealed file, which is why the KDF cost is the real defence and
 * this is the courtesy layer on top of it.
 */
export function lockoutMs(failures: number): number {
  if (failures < 3) return 0;
  return Math.min(2 ** (failures - 2) * 1000, 5 * 60 * 1000);
}
