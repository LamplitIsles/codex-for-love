export interface RecoveryStream { close(): void; onopen: ((event: Event) => void) | null; onerror: ((event: Event) => void) | null; onmessage: ((event: MessageEvent) => void) | null; addEventListener(name: 'heartbeat', listener: (event: Event) => void): void; }
export interface RecoveryWindow { visible(): boolean; on(name: 'online' | 'visibilitychange' | 'pageshow', listener: () => void): () => void; setTimeout(listener: () => void, ms: number): number; clearTimeout(id: number): void; }

/** The one owner of a Companion page's stream, catch-up, retry and liveness state. */
export class CompanionRecovery {
  private stream?: RecoveryStream; private abort?: AbortController; private retry?: number; private watchdog?: number; private timeout?: number;
  private generation = 0; private invalidatedGeneration = 0; private failures = 0; private disposed = false; private synced = false; private lastEvent = 0; private syncing?: Promise<void>; private refreshAgain = false;
  private readonly off: (() => void)[];
  private readonly options: { open(): RecoveryStream; sync(signal: AbortSignal, generation: number): Promise<void>; window: RecoveryWindow; now(): number; changed(synced: boolean): void; };
  constructor(options: { open(): RecoveryStream; sync(signal: AbortSignal, generation: number): Promise<void>; window: RecoveryWindow; now(): number; changed(synced: boolean): void; }) {
    this.options = options;
    this.off = ['online', 'pageshow'].map(name => options.window.on(name as 'online', () => this.foreground()));
    this.off.push(options.window.on('visibilitychange', () => options.window.visible() ? this.foreground() : this.pause()));
  }
  start(): void { this.replace(); }
  private pause(): void { if (this.retry) this.options.window.clearTimeout(this.retry); if (this.watchdog) this.options.window.clearTimeout(this.watchdog); this.retry = this.watchdog = undefined; }
  private foreground(): void { if (!this.disposed && this.options.window.visible()) this.replace(); }
  private event = (): void => { this.lastEvent = this.options.now(); if (this.watchdog) this.options.window.clearTimeout(this.watchdog); this.watchdog = undefined; if (this.synced) this.watch(); };
  replace(): void {
    if (this.disposed || !this.options.window.visible()) return;
    this.pause(); if (this.timeout) this.options.window.clearTimeout(this.timeout); this.timeout = undefined;
    this.generation += 1; const generation = this.generation; this.lastEvent = this.options.now(); this.abort?.abort(); this.stream?.close(); this.synced = false; this.options.changed(false);
    const stream = this.stream = this.options.open(); stream.onopen = this.event;
    stream.onmessage = () => { this.event(); void this.catchUp(generation); };
    stream.addEventListener('heartbeat', this.event);
    stream.onerror = () => { if (!this.disposed && generation === this.generation) { if (this.watchdog) this.options.window.clearTimeout(this.watchdog); this.watchdog = undefined; this.invalidatedGeneration = generation; this.abort?.abort(); this.options.changed(false); this.synced = false; this.schedule(); } };
    void this.catchUp(generation);
  }
  private catchUp(generation: number): Promise<void> {
    if (this.disposed || generation !== this.generation) return Promise.resolve();
    this.refreshAgain = true;
    // A replacement can arrive while an older generation owns the physical
    // read.  Wait for it to release ownership, then start this generation's
    // requested catch-up; never let the old promise stand in for a new read.
    if (this.syncing) {
      const old = this.syncing;
      return old.finally(() => undefined).then(() => {
        if (this.syncing === old) this.syncing = undefined;
        return this.catchUp(generation);
      });
    }
    this.syncing = (async () => {
      while (this.refreshAgain && !this.disposed && generation === this.generation) {
        this.refreshAgain = false; this.abort?.abort(); const abort = this.abort = new AbortController();
        this.timeout = this.options.window.setTimeout(() => abort.abort(), 15000);
        try { await this.options.sync(abort.signal, generation); }
        finally { if (this.timeout) this.options.window.clearTimeout(this.timeout); this.timeout = undefined; }
      }
      if (!this.disposed && generation === this.generation && this.invalidatedGeneration !== generation) { this.failures = 0; this.synced = true; this.options.changed(true); this.watch(); }
    })().catch(() => { if (!this.disposed && generation === this.generation) this.schedule(); }).finally(() => { this.syncing = undefined; });
    return this.syncing;
  }
  private schedule(): void { if (this.retry || this.disposed || !this.options.window.visible()) return; const delay = [1000, 2000, 4000, 8000, 15000][Math.min(this.failures++, 4)]!; this.retry = this.options.window.setTimeout(() => { this.retry = undefined; this.replace(); }, delay); }
  private watch(): void { if (this.watchdog || this.disposed || !this.options.window.visible()) return; const delay = Math.max(0, this.lastEvent + 45000 - this.options.now()); this.watchdog = this.options.window.setTimeout(() => { this.watchdog = undefined; if (this.options.now() - this.lastEvent >= 45000) this.replace(); else this.watch(); }, delay); }
  close(): void { this.disposed = true; this.abort?.abort(); this.stream?.close(); this.pause(); if (this.timeout) this.options.window.clearTimeout(this.timeout); this.off.forEach(off => off()); }
}
