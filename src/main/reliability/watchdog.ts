import type { WebContentsView } from "electron";

/**
 * Reliability layer.
 *
 * A chat client that silently sits on a blank white view after a renderer
 * crash or a laptop resume is worse than one that crashes loudly. The watchdog
 * turns the four ways a view can die — crash, hang, load failure, and a
 * network partition — into one behaviour: back off, then reload.
 *
 * Backoff is capped and reset on success so a flaky connection does not turn
 * into a reload storm against Discord's servers.
 */

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

/**
 * Chromium network errors that are not failures we should retry.
 *
 * `ERR_ABORTED` is reported for every ordinary cancelled navigation, including
 * each SPA route change. `ERR_BLOCKED_BY_CLIENT` is *our own* privacy filter
 * refusing the request — retrying it would spin the watchdog against a rule
 * that will never let it through, and would fill the ledger with phantom
 * blocks that make the Privacy Inspector lie about how much traffic occurred.
 */
const IGNORED_LOAD_ERRORS = new Set([
  -3, // ERR_ABORTED
  -20, // ERR_BLOCKED_BY_CLIENT
]);

export interface WatchdogHooks {
  /** Called when the view enters a failed state, with a human-readable cause. */
  onDegraded?: (cause: string) => void;
  onRecovered?: () => void;
}

export class ViewWatchdog {
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly view: WebContentsView,
    private readonly homeUrl: string,
    private readonly hooks: WatchdogHooks = {},
  ) {
    this.attach();
  }

  private attach(): void {
    const contents = this.view.webContents;

    contents.on("render-process-gone", (_event, details) => {
      this.degrade(`renderer exited (${details.reason})`);
    });

    contents.on("unresponsive", () => {
      this.hooks.onDegraded?.("window is not responding");
    });

    contents.on("responsive", () => {
      this.hooks.onRecovered?.();
    });

    contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || IGNORED_LOAD_ERRORS.has(errorCode)) return;
      this.degrade(`${errorDescription || "load failed"} (${validatedURL})`);
    });

    contents.on("did-finish-load", () => {
      if (this.attempt > 0) this.hooks.onRecovered?.();
      this.attempt = 0;
    });
  }

  private degrade(cause: string): void {
    if (this.disposed) return;
    this.hooks.onDegraded?.(cause);
    this.scheduleReload();
  }

  private scheduleReload(): void {
    if (this.timer || this.disposed) return;
    const delay = Math.min(BASE_DELAY_MS * 2 ** this.attempt, MAX_DELAY_MS);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.reload();
    }, delay);
  }

  /** Forces an immediate reload and resets the backoff — used by "Reload" in the menu. */
  reload(): void {
    if (this.disposed) return;
    const contents = this.view.webContents;
    if (contents.isDestroyed()) return;
    if (contents.getURL()) contents.reload();
    else void contents.loadURL(this.homeUrl);
  }

  /** Called when the OS reports the network came back. */
  onNetworkOnline(): void {
    if (this.attempt === 0) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.reload();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
