import type { LedgerEntry, LedgerSnapshot } from "../../common/ipc";
import type { RuleCategory } from "../../common/rules";

/**
 * The Privacy Inspector's backing store.
 *
 * Every block decision is recorded so the user can audit the claim rather than
 * trust it. The ledger is memory-only and bounded: it is a debugging and
 * verification aid, not a log file, and writing a list of every URL you
 * touched to disk would be its own privacy problem.
 */
const MAX_ENTRIES = 500;

export class PrivacyLedger {
  private readonly entries: LedgerEntry[] = [];
  private readonly totals = new Map<RuleCategory, number>();
  private readonly since = Date.now();
  private listener: (() => void) | null = null;
  private notifyTimer: NodeJS.Timeout | null = null;

  onChange(listener: () => void): void {
    this.listener = listener;
  }

  record(entry: LedgerEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.totals.set(entry.category, (this.totals.get(entry.category) ?? 0) + 1);
    this.scheduleNotify();
  }

  /**
   * Blocked requests arrive in bursts (a channel switch can fire dozens), so
   * the UI is nudged on a timer instead of once per event.
   */
  private scheduleNotify(): void {
    if (this.notifyTimer || !this.listener) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.listener?.();
    }, 400);
  }

  snapshot(profileId?: string): LedgerSnapshot {
    const recent = (profileId ? this.entries.filter((e) => e.profileId === profileId) : this.entries)
      .slice(-120)
      .reverse();
    const totals: Partial<Record<RuleCategory, number>> = {};
    for (const [category, count] of this.totals) totals[category] = count;
    return { totals, recent, since: this.since };
  }

  clear(): void {
    this.entries.length = 0;
    this.totals.clear();
    this.listener?.();
  }
}
