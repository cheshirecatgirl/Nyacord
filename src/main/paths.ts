import { app } from "electron";
import { existsSync, mkdirSync, accessSync, constants } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { decidePortable, PORTABLE_DIR_NAME, type PortableDecision } from "../common/portable";

let decision: PortableDecision | null = null;

/**
 * The directory the app was launched from. For a packaged build this is where
 * the executable lives; unpackaged we walk up out of `dist/` so that a
 * developer's `nyacord-data` sits at the project root.
 */
function execDir(): string {
  if (app.isPackaged) return dirname(app.getPath("exe"));
  return resolve(__dirname, "..", "..", "..");
}

function writable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Must run before `app.whenReady()`. Redirecting Chromium's paths afterwards
 * is unreliable, because the cache and session directories are captured during
 * startup.
 *
 * If the portable directory turns out to be read-only (burned to a disc,
 * mounted noexec, a locked USB stick) we fall back to the OS location and say
 * so, instead of silently failing to persist anything.
 */
export function initializePaths(): PortableDecision {
  if (decision) return decision;

  const dir = execDir();
  const result = decidePortable({
    argv: process.argv,
    env: process.env,
    execDir: dir,
    markerExists: existsSync(join(dir, PORTABLE_DIR_NAME)),
    join,
  });

  if (result.portable && result.dataDir && writable(result.dataDir)) {
    const root = result.dataDir;
    app.setPath("userData", root);
    app.setPath("sessionData", join(root, "session"));
    app.setPath("logs", join(root, "logs"));
    app.setPath("crashDumps", join(root, "crash"));
    decision = result;
  } else if (result.portable) {
    decision = {
      portable: false,
      reason: "not-portable",
      dataDir: null,
    };
  } else {
    decision = result;
  }

  return decision;
}

export function pathDecision(): PortableDecision {
  return decision ?? { portable: false, reason: "not-portable", dataDir: null };
}

export function dataRoot(): string {
  return app.getPath("userData");
}

export function configFile(): string {
  return join(dataRoot(), "config.json");
}
