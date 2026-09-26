export interface NotificationTurnResult {
  turnId: string;
  status: string;
}

export function shouldNotifyForPageState(visibilityState: DocumentVisibilityState, hasFocus: boolean): boolean {
  return visibilityState === "hidden" || !hasFocus;
}

/** Tracks completed turns observed by one live Companion page. */
export class CompanionNotificationObserver {
  readonly #completed = new Set<string>();
  #ready = false;

  observe(results: readonly NotificationTurnResult[]): string[] {
    const completed = results.filter((result) => result.status === "completed");
    if (!this.#ready) {
      for (const result of completed) this.#completed.add(result.turnId);
      this.#ready = true;
      return [];
    }

    const fresh: string[] = [];
    for (const result of completed) {
      if (this.#completed.has(result.turnId)) continue;
      this.#completed.add(result.turnId);
      fresh.push(result.turnId);
    }
    return fresh;
  }
}
