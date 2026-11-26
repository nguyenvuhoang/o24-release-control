// Framework-agnostic helpers behind Dashboard.tsx's background poll: bounded
// exponential backoff on consecutive failures, and a coalescing fetcher that
// collapses overlapping calls into the one in-flight request instead of
// firing a duplicate round trip. Kept free of React/DOM so the logic that
// actually matters (backoff math, overlap-coalescing) is unit-testable
// without a browser environment.

/**
 * `baseIntervalMs` while healthy; grows by `2^min(consecutiveFailures,2)`,
 * capped at `maxIntervalMs`, once requests start failing — so a down
 * backend gets hit less often the longer it stays down, but polling never
 * stops outright (it always keeps retrying at the capped interval).
 */
export function computeBackoffDelayMs(baseIntervalMs: number, maxIntervalMs: number, consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return baseIntervalMs
  return Math.min(baseIntervalMs * 2 ** Math.min(consecutiveFailures, 2), maxIntervalMs)
}

/**
 * Collapses concurrent `fetch()` calls into the ONE underlying `run()` call
 * already in flight — a second caller (e.g. the poll timer firing right as
 * a user action's own refresh is still in flight) gets the exact same
 * promise instead of triggering a duplicate network round trip, and still
 * receives the real resolved value (never a stale/skipped result).
 */
export class CoalescingFetcher<T> {
  private inFlight: Promise<T> | null = null

  constructor(private readonly run: () => Promise<T>) {}

  get isInFlight(): boolean {
    return this.inFlight !== null
  }

  async fetch(): Promise<T> {
    if (this.inFlight) return this.inFlight
    const promise = this.run()
    this.inFlight = promise
    try {
      return await promise
    } finally {
      this.inFlight = null
    }
  }
}
