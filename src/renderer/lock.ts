/**
 * The lock screen. Holds the passphrase only long enough to hand it to the main
 * process, then clears the field. JavaScript cannot erase the string itself,
 * but leaving one sitting in a focused input across a failed attempt is a habit
 * to avoid.
 */

import type { UnlockOutcome, VaultState } from "../common/ipc";
import type { NyaLockApi } from "../preload/lock";

const nya = (window as unknown as { nyaLock: NyaLockApi }).nyaLock;

const form = document.getElementById("lock-form") as HTMLFormElement;
const field = document.getElementById("passphrase") as HTMLInputElement;
const submit = document.getElementById("submit") as HTMLButtonElement;
const error = document.getElementById("lock-error") as HTMLParagraphElement;
const warning = document.getElementById("lock-warning") as HTMLParagraphElement;
const subtitle = document.getElementById("lock-sub") as HTMLParagraphElement;

let retryTimer: number | null = null;

function say(message: string): void {
  error.textContent = message;
}

/** Counts a lockout down in place, so the wait is visible instead of mysterious. */
function holdFor(ms: number): void {
  if (retryTimer !== null) window.clearInterval(retryTimer);

  let left = Math.ceil(ms / 1000);
  const tick = (): void => {
    if (left <= 0) {
      window.clearInterval(retryTimer ?? 0);
      retryTimer = null;
      submit.disabled = false;
      field.disabled = false;
      say("");
      field.focus();
      return;
    }
    say(`Too many attempts. Try again in ${left}s.`);
    left -= 1;
  };

  submit.disabled = true;
  field.disabled = true;
  tick();
  retryTimer = window.setInterval(tick, 1000);
}

function report(outcome: UnlockOutcome): void {
  if (outcome.ok) {
    field.value = "";
    say("");
    return;
  }

  if (outcome.retryInMs > 0) {
    holdFor(outcome.retryInMs);
    return;
  }

  submit.disabled = false;
  field.disabled = false;

  if (outcome.reason === "corrupt") {
    // Kept apart from a wrong passphrase; retyping will not fix this one.
    say("The passphrase was right, but the sealed data could not be opened.");
    return;
  }

  say("That passphrase did not work.");
  field.select();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const passphrase = field.value;
  if (passphrase.length === 0) return;

  submit.disabled = true;
  say("Opening…");

  void nya.unlock(passphrase).then(report, () => {
    submit.disabled = false;
    say("Something went wrong opening the vault.");
  });

  field.value = "";
});

nya.onState((state: VaultState) => {
  subtitle.textContent = state.sealed
    ? "Your profile data is sealed."
    : "Enter your passphrase to continue.";

  warning.classList.toggle("hidden", !state.leftUnsealed);
  warning.textContent = state.leftUnsealed
    ? "A previous session ended without sealing. Readable data was left on disk; it will be sealed when you next quit."
    : "";

  if (state.retryInMs > 0) holdFor(state.retryInMs);
  else field.focus();
});

field.focus();
