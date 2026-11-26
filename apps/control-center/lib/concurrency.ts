// Bounded-concurrency map: runs `fn` over `items` with at most `concurrency`
// in flight at once, preserving input order in the returned array. Extracted
// from releaseMetadataBackfill.ts's worker-pool pattern so any fan-out that
// talks to a shared, rate-limited backend (the Redis Gateway, GitHub, Docker
// Hub) can cap its own peak concurrency without re-implementing the pool —
// see docs/REDIS_GATEWAY.md's root-cause note on uncapped Promise.all fan-out
// overwhelming the Gateway during Dashboard load.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  if (items.length === 0) return results
  const limit = Math.max(1, Math.min(concurrency, items.length))
  let cursor = 0
  async function worker() {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: limit }, worker))
  return results
}
