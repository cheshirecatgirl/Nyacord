import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A small, dependency-free, crash-safe JSON store.
 *
 * Writes go to a temporary file and are renamed into place, which is atomic on
 * every platform we target. A corrupted config is moved aside rather than
 * deleted, and startup continues with defaults — losing your window position
 * is acceptable, refusing to launch is not.
 */
export class JsonStore<T extends object> {
  private data: T;
  private writeTimer: NodeJS.Timeout | null = null;
  private readonly file: string;
  private readonly defaults: () => T;

  constructor(file: string, defaults: () => T) {
    this.file = file;
    this.defaults = defaults;
    this.data = this.load();
  }

  private load(): T {
    if (!existsSync(this.file)) return this.defaults();
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      return { ...this.defaults(), ...(parsed as T) };
    } catch (error) {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        copyFileSync(this.file, backup);
      } catch {
        /* best effort; the point is not to lose the user's data silently */
      }
      console.error(`[nyacord] config unreadable (${String(error)}); kept a copy at ${backup}`);
      return this.defaults();
    }
  }

  get(): Readonly<T> {
    return this.data;
  }

  update(mutator: (draft: T) => void): void {
    mutator(this.data);
    this.scheduleWrite();
  }

  replace(next: T): void {
    this.data = next;
    this.scheduleWrite();
  }

  private scheduleWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => this.flush(), 250);
  }

  /** Synchronous by design: called from `before-quit`, where async loses races. */
  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (error) {
      console.error("[nyacord] failed to persist config:", error);
    }
  }
}
