import type { DecisionCacheConfig } from "./types.ts";

export type CachedDecision = {
  decision: "allow" | "block";
  reason: string;
  cachedAt: number;
};

type CacheEntry = CachedDecision & { expiresAt: number };

/**
 * Per-session LRU cache for classifier decisions, keyed by
 * `toolName + "\0" + command + "\0" + cwd`. Only classifier outcomes are
 * cached: deterministic checks (permissions, hard-deny, read-only fast path,
 * bash fast path) are free and always re-run, so a cached decision can never
 * bypass them.
 *
 * Not persisted across sessions by design: the transcript context the
 * classifier sees differs between sessions, so cross-session reuse could
 * produce stale decisions for changed intent.
 */
export class DecisionCache {
  private entries = new Map<string, CacheEntry>();
  private config: DecisionCacheConfig;

  constructor(config: DecisionCacheConfig) {
    this.config = config;
  }

  updateConfig(config: DecisionCacheConfig): void {
    this.config = config;
    this.prune();
  }

  private prune(): void {
    if (this.entries.size <= this.config.maxEntries) return;
    // Map preserves insertion order; evict oldest first.
    const excess = this.entries.size - this.config.maxEntries;
    let evicted = 0;
    for (const key of this.entries.keys()) {
      if (evicted >= excess) break;
      this.entries.delete(key);
      evicted += 1;
    }
  }

  private valid(entry: CacheEntry): boolean {
    return Date.now() < entry.expiresAt;
  }

  static key(
    toolName: string,
    input: Record<string, unknown>,
    cwd: string,
  ): string {
    const command = typeof input.command === "string"
      ? input.command
      : JSON.stringify(input);
    return `${toolName}\0${command}\0${cwd}`;
  }

  get(key: string): CachedDecision | undefined {
    if (!this.config.enabled) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (!this.valid(entry)) {
      this.entries.delete(key);
      return undefined;
    }
    // LRU refresh: re-insert to move to the back.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { decision: entry.decision, reason: entry.reason, cachedAt: entry.cachedAt };
  }

  set(key: string, decision: "allow" | "block", reason: string): void {
    if (!this.config.enabled) return;
    this.entries.delete(key);
    this.entries.set(key, {
      decision,
      reason,
      cachedAt: Date.now(),
      expiresAt: Date.now() + this.config.ttlMs,
    });
    this.prune();
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
