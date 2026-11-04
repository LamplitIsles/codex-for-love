/** Per-catalog, in-memory LRU of immutable thumbnail bytes. */
export class StickerThumbnailCache {
  private readonly values = new Map<string, Buffer>();
  private readonly pending = new Map<string, Promise<Buffer>>();
  private size = 0;
  private generation = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxPending: number;

  constructor(maxEntries = 64, maxBytes = 2 * 1024 * 1024, maxPending = 64) {
    this.maxEntries = maxEntries; this.maxBytes = maxBytes; this.maxPending = maxPending;
  }

  async get(version: string, generate: () => Promise<Buffer>): Promise<Buffer> {
    const cached = this.values.get(version);
    if (cached) {
      this.values.delete(version); this.values.set(version, cached);
      return Buffer.from(cached);
    }
    let task = this.pending.get(version);
    if (!task) {
      if (this.pending.size >= this.maxPending) throw new Error('Sticker thumbnail processing is busy');
      const generation = this.generation;
      task = Promise.resolve().then(generate).then(bytes => {
        if (generation === this.generation && bytes.length > 0 && bytes.length <= this.maxBytes && this.maxEntries > 0) {
          while (this.values.size >= this.maxEntries || this.size + bytes.length > this.maxBytes) {
            const oldest = this.values.keys().next().value!;
            this.size -= this.values.get(oldest)!.length; this.values.delete(oldest);
          }
          const stored = Buffer.from(bytes); this.values.set(version, stored); this.size += stored.length;
        }
        return bytes;
      }).finally(() => { this.pending.delete(version); });
      this.pending.set(version, task);
    }
    return Buffer.from(await task);
  }

  clear(): void { this.values.clear(); this.size = 0; this.generation++; }
}
