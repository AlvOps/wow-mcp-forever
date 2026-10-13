interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  bytes: number;
}

/**
 * Map-backed TTL cache, LRU by recency, bounded by entry count and (optionally)
 * total weight.
 *
 * Both bounds matter for this project: Wowhead entity pages are ~250KB-850KB of
 * HTML, so an entry-count-only cap lets a long-lived server grow to ~1GB of
 * strings. Pass `weigh` (e.g. `(s: string) => s.length`) to cap total bytes.
 */
export class TtlCache<T = unknown> {
  private store = new Map<string, CacheEntry<T>>();
  private bytes = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxSize: number,
    private readonly maxBytes = Number.POSITIVE_INFINITY,
    private readonly weigh: (value: T) => number = () => 0,
  ) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.drop(key, entry);
      return undefined;
    }
    // Re-insert to mark as most recently used. Without this the eviction order
    // is insertion order and a hot page can be evicted by a cold one.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    const prev = this.store.get(key);
    if (prev) this.drop(key, prev);

    const bytes = Math.max(0, this.weigh(value) || 0);
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs, bytes });
    this.bytes += bytes;
    this.evict();
  }

  invalidate(key: string): void {
    const entry = this.store.get(key);
    if (entry) this.drop(key, entry);
  }

  clear(): void {
    this.store.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.store.size;
  }

  /** Total weight currently held, as reported by `weigh`. */
  get byteSize(): number {
    return this.bytes;
  }

  private drop(key: string, entry: CacheEntry<T>): void {
    this.store.delete(key);
    this.bytes -= entry.bytes;
  }

  private evict(): void {
    while (this.store.size > 0 && (this.store.size > this.maxSize || this.bytes > this.maxBytes)) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      const entry = this.store.get(oldest)!;
      this.drop(oldest, entry);
    }
  }
}