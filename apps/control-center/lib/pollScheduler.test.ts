import assert from 'node:assert/strict'
import test from 'node:test'
import { computeBackoffDelayMs, CoalescingFetcher } from './pollScheduler'

// ---- computeBackoffDelayMs ----

test('no failures stays at the base interval', () => {
  assert.equal(computeBackoffDelayMs(15_000, 60_000, 0), 15_000)
})

test('backoff doubles per consecutive failure, capped at maxIntervalMs', () => {
  assert.equal(computeBackoffDelayMs(15_000, 60_000, 1), 30_000)
  assert.equal(computeBackoffDelayMs(15_000, 60_000, 2), 60_000)
  assert.equal(computeBackoffDelayMs(15_000, 60_000, 3), 60_000, 'never exceeds the cap')
  assert.equal(computeBackoffDelayMs(15_000, 60_000, 50), 60_000, 'stays capped no matter how long the outage runs — polling never stops')
})

// ---- CoalescingFetcher: overlapping-request prevention / dedup ----

test('a second fetch() while one is already in flight gets the SAME promise — no duplicate run()', async () => {
  let runCount = 0
  let resolveFirst: (value: string) => void = () => {}
  const fetcher = new CoalescingFetcher(() => {
    runCount += 1
    return new Promise<string>((resolve) => {
      resolveFirst = resolve
    })
  })

  const first = fetcher.fetch()
  assert.equal(fetcher.isInFlight, true)
  const second = fetcher.fetch()
  assert.equal(runCount, 1, 'run() must be called exactly once for two overlapping fetch() calls')

  resolveFirst('result')
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult, 'result')
  assert.equal(secondResult, 'result', 'the coalesced caller must receive the real resolved value, never undefined/stale')
  assert.equal(fetcher.isInFlight, false)
})

test('after the in-flight call settles, the NEXT fetch() runs a fresh call', async () => {
  let runCount = 0
  const fetcher = new CoalescingFetcher(async () => {
    runCount += 1
    return runCount
  })

  assert.equal(await fetcher.fetch(), 1)
  assert.equal(await fetcher.fetch(), 2)
  assert.equal(runCount, 2)
})

test('a rejection clears the in-flight state too, so the next call can retry', async () => {
  let attempt = 0
  const fetcher = new CoalescingFetcher(async () => {
    attempt += 1
    if (attempt === 1) throw new Error('transient')
    return 'ok'
  })

  await assert.rejects(() => fetcher.fetch())
  assert.equal(fetcher.isInFlight, false)
  assert.equal(await fetcher.fetch(), 'ok')
})

test('three concurrent callers during one in-flight run all resolve to that one run — exactly one underlying call', async () => {
  let runCount = 0
  const fetcher = new CoalescingFetcher(async () => {
    runCount += 1
    await new Promise((resolve) => setTimeout(resolve, 5))
    return 'v'
  })

  const results = await Promise.all([fetcher.fetch(), fetcher.fetch(), fetcher.fetch()])
  assert.deepEqual(results, ['v', 'v', 'v'])
  assert.equal(runCount, 1)
})
