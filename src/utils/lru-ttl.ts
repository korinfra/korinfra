interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class LruTtl<K, V> {
  private readonly map = new Map<K, Entry<V>>();

  constructor(
    private readonly maxSize: number,
    private readonly ttlMs: number,
  ) {}

  get(k: K): V | undefined {
    const entry = this.map.get(k);
    if (entry === undefined) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(k);
      return undefined;
    }
    // Re-insert to move to most-recently-used position
    this.map.delete(k);
    this.map.set(k, entry);
    return entry.value;
  }

  set(k: K, v: V): void {
    if (this.map.has(k)) {
      this.map.delete(k);
    }
    this.map.set(k, { value: v, expiresAt: Date.now() + this.ttlMs });
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next();
      if (!oldest.done) {
        this.map.delete(oldest.value);
      }
    }
  }

  delete(k: K): boolean {
    return this.map.delete(k);
  }

  has(k: K): boolean {
    const entry = this.map.get(k);
    if (entry === undefined) return false;
    if (Date.now() > entry.expiresAt) return false;
    return true;
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
