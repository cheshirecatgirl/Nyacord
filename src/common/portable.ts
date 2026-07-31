/**
 * Portability decision logic.
 *
 * Telegram Desktop and its forks get portability right in a way most Electron
 * apps do not: the rule is "if a data directory sits next to the executable,
 * use it and touch nothing else on the machine". No registry, no
 * `~/.config` fallback behind your back, no surprise state left on a friend's
 * PC after you unplug the USB stick.
 *
 * The decision is pure so it can be tested without a filesystem or Electron.
 */

export type PortableReason =
  | "flag" // --portable was passed
  | "env" // NYACORD_PORTABLE=1
  | "marker" // a `nyacord-data` directory exists beside the executable
  | "explicit-path" // --data-dir=… was passed
  | "not-portable";

export interface PortableInputs {
  /** Raw argv, minus the executable itself is fine; the parser is tolerant. */
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Directory containing the executable (or the project root when unpackaged). */
  readonly execDir: string;
  /** Does `<execDir>/nyacord-data` already exist? */
  readonly markerExists: boolean;
  /** Platform-appropriate join, injected so this module stays dependency-free. */
  readonly join: (...parts: string[]) => string;
}

export interface PortableDecision {
  readonly portable: boolean;
  readonly reason: PortableReason;
  /** Absolute path Nyacord should use for all writable state, or null to keep OS defaults. */
  readonly dataDir: string | null;
}

export const PORTABLE_DIR_NAME = "nyacord-data";

function readFlagValue(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    if (arg === `--${name}`) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) return next;
    }
  }
  return null;
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

export function decidePortable(inputs: PortableInputs): PortableDecision {
  const explicit = readFlagValue(inputs.argv, "data-dir");
  if (explicit && explicit.length > 0) {
    return { portable: true, reason: "explicit-path", dataDir: explicit };
  }

  const beside = inputs.join(inputs.execDir, PORTABLE_DIR_NAME);

  if (hasFlag(inputs.argv, "portable")) {
    return { portable: true, reason: "flag", dataDir: beside };
  }

  const envValue = inputs.env["NYACORD_PORTABLE"];
  if (envValue === "1" || envValue === "true") {
    return { portable: true, reason: "env", dataDir: beside };
  }

  if (inputs.markerExists) {
    return { portable: true, reason: "marker", dataDir: beside };
  }

  return { portable: false, reason: "not-portable", dataDir: null };
}
