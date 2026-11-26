import test from 'node:test'
import assert from 'node:assert/strict'
import { mapWithConcurrency } from './concurrency'

test('mapWithConcurrency preserves input order regardless of completion order', async () => {
  const delays = [30, 10, 20, 5]
  const results = await mapWithConcurrency(delays, 4, async (delay, index) => {
    await new Promise((resolve) => setTimeout(resolve, delay))
    return index
  })
  assert.deepEqual(results, [0, 1, 2, 3])
})

test('mapWithConcurrency never runs more than `concurrency` callbacks at once', async () => {
  let active = 0
  let maxActive = 0
  await mapWithConcurrency(Array.from({ length: 10 }), 3, async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
  })
  assert.ok(maxActive <= 3, `expected max 3 concurrent, saw ${maxActive}`)
})

test('mapWithConcurrency returns an empty array for an empty input without calling fn', async () => {
  let called = false
  const results = await mapWithConcurrency([], 3, async () => {
    called = true
    return 1
  })
  assert.deepEqual(results, [])
  assert.equal(called, false)
})

test('mapWithConcurrency clamps an absurd or non-positive concurrency to at least 1', async () => {
  const results = await mapWithConcurrency([1, 2, 3], 0, async (item) => item * 2)
  assert.deepEqual(results, [2, 4, 6])
})

test('mapWithConcurrency propagates a thrown error from any worker', async () => {
  await assert.rejects(
    () =>
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('boom')
        return item
      }),
    /boom/,
  )
})
