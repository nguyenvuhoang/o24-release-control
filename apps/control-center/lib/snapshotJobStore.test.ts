import assert from 'node:assert/strict'
import test from 'node:test'
import { KvSnapshotJobStore } from './snapshotJobStore'

// Minimal in-memory stand-in for Upstash's REST protocol, extended (beyond
// the GET/SET-NX mock used elsewhere) to support the sorted-set commands
// this store needs: ZADD, ZREM, ZRANGEBYSCORE ... LIMIT, MGET.
type MockKvStore = { strings: Map<string, string>; zsets: Map<string, Map<string, number>> }

function handleKvCommand(store: MockKvStore, command: unknown[]): unknown {
  const [op, ...args] = command as (string | number)[]
  if (op === 'GET') {
    const key = String(args[0])
    return store.strings.has(key) ? store.strings.get(key) : null
  }
  if (op === 'SET') {
    const [key, value] = args as [string, string]
    store.strings.set(key, value)
    return 'OK'
  }
  if (op === 'MGET') {
    return args.map((key) => (store.strings.has(String(key)) ? store.strings.get(String(key)) : null))
  }
  if (op === 'ZADD') {
    const [key, score, member] = args as [string, number, string]
    if (!store.zsets.has(key)) store.zsets.set(key, new Map())
    store.zsets.get(key)!.set(member, Number(score))
    return 1
  }
  if (op === 'ZREM') {
    const [key, member] = args as [string, string]
    return store.zsets.get(key)?.delete(member) ? 1 : 0
  }
  if (op === 'ZRANGEBYSCORE') {
    const [key, min, max] = args as [string, string | number, string | number]
    const zset = store.zsets.get(key)
    if (!zset) return []
    const minScore = min === '-inf' ? -Infinity : Number(min)
    const maxScore = max === '+inf' ? Infinity : Number(max)
    const limitIndex = args.indexOf('LIMIT')
    const limit = limitIndex !== -1 ? Number(args[limitIndex + 2]) : Infinity
    return [...zset.entries()]
      .filter(([, score]) => score >= minScore && score <= maxScore)
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit)
      .map(([member]) => member)
  }
  throw new Error(`Mock KV does not support command: ${op}`)
}

function makeStore(): { store: KvSnapshotJobStore; kv: MockKvStore } {
  const kv: MockKvStore = { strings: new Map(), zsets: new Map() }
  const config = { url: 'https://fake-kv.example.com', token: 'fake-token' }
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const command = JSON.parse(String(init?.body))
    const result = handleKvCommand(kv, command)
    return new Response(JSON.stringify({ result }), { status: 200 })
  }) as typeof fetch
  test.after(() => {
    globalThis.fetch = originalFetch
  })
  return { store: new KvSnapshotJobStore(config), kv }
}

function baseInput(overrides: Partial<Parameters<KvSnapshotJobStore['upsertPending']>[0]> = {}) {
  return {
    service: 'CMS' as const,
    runId: 5001,
    runAttempt: 1,
    branch: 'developer',
    commitSha: 'a'.repeat(40),
    htmlUrl: 'https://github.com/x/y/actions/runs/5001',
    createdBySource: 'github-webhook',
    ...overrides,
  }
}

test('upsertPending creates a new pending job and indexes it in the pending ZSET', async () => {
  const { store, kv } = makeStore()
  const job = await store.upsertPending(baseInput())
  assert.equal(job.status, 'pending')
  assert.equal(job.attemptCount, 0)
  assert.equal(job.id, 'CMS:5001')
  assert.ok(kv.zsets.get('o24:snapshot-job:pending')?.has('CMS:5001'))
})

test('upsertPending for the SAME runAttempt is idempotent — does not reset attemptCount/status', async () => {
  const { store } = makeStore()
  await store.upsertPending(baseInput())
  await store.markRetry('CMS', 5001, 'digest_not_found', new Date(Date.now() + 30_000).toISOString())
  const afterRetry = await store.getJob('CMS', 5001)
  assert.equal(afterRetry?.attemptCount, 1)

  const duplicateDelivery = await store.upsertPending(baseInput())
  assert.equal(duplicateDelivery.attemptCount, 1) // unchanged — NOT reset back to 0
})

test('upsertPending for a DIFFERENT runAttempt (a re-run) resets the job as fresh', async () => {
  const { store } = makeStore()
  await store.upsertPending(baseInput({ runAttempt: 1 }))
  await store.markRetry('CMS', 5001, 'digest_not_found', new Date(Date.now() + 30_000).toISOString())

  const reRun = await store.upsertPending(baseInput({ runAttempt: 2 }))
  assert.equal(reRun.runAttempt, 2)
  assert.equal(reRun.attemptCount, 0)
  assert.equal(reRun.status, 'pending')
})

test('markCompletedIfExists sets status=completed, records releaseId, and removes the job from the pending ZSET', async () => {
  const { store, kv } = makeStore()
  await store.upsertPending(baseInput())
  await store.markCompletedIfExists('CMS', 5001, 'release:CMS:5001:1')

  const job = await store.getJob('CMS', 5001)
  assert.equal(job?.status, 'completed')
  assert.equal(job?.releaseId, 'release:CMS:5001:1')
  assert.equal(kv.zsets.get('o24:snapshot-job:pending')?.has('CMS:5001'), false)
})

test('markCompletedIfExists is a no-op when no job exists for this service+runId', async () => {
  const { store } = makeStore()
  await store.markCompletedIfExists('CMS', 9999, 'release:x')
  const job = await store.getJob('CMS', 9999)
  assert.equal(job, undefined)
})

test('markRetry increments attemptCount, records lastError, and moves the ZSET score to nextRetryAt', async () => {
  const { store, kv } = makeStore()
  await store.upsertPending(baseInput())
  const nextRetryAt = new Date(Date.now() + 60_000).toISOString()
  await store.markRetry('CMS', 5001, 'digest_not_found', nextRetryAt)

  const job = await store.getJob('CMS', 5001)
  assert.equal(job?.attemptCount, 1)
  assert.equal(job?.lastError, 'digest_not_found')
  assert.equal(job?.status, 'pending')
  assert.equal(kv.zsets.get('o24:snapshot-job:pending')?.get('CMS:5001'), Date.parse(nextRetryAt))
})

test('markFailedTerminal sets status=failed and removes the job from the pending ZSET (no more retries)', async () => {
  const { store, kv } = makeStore()
  await store.upsertPending(baseInput())
  await store.markFailedTerminal('CMS', 5001, 'exceeded max reconcile attempts')

  const job = await store.getJob('CMS', 5001)
  assert.equal(job?.status, 'failed')
  assert.equal(job?.lastError, 'exceeded max reconcile attempts')
  assert.equal(kv.zsets.get('o24:snapshot-job:pending')?.has('CMS:5001'), false)
})

test('listDuePending only returns jobs whose nextRetryAt has passed, oldest first', async () => {
  const { store } = makeStore()
  const now = Date.now()
  await store.upsertPending(baseInput({ runId: 1 }))
  await store.markRetry('CMS', 1, 'x', new Date(now - 10_000).toISOString()) // due
  await store.upsertPending(baseInput({ runId: 2 }))
  await store.markRetry('CMS', 2, 'x', new Date(now + 60_000).toISOString()) // not due yet
  await store.upsertPending(baseInput({ runId: 3 }))
  await store.markRetry('CMS', 3, 'x', new Date(now - 20_000).toISOString()) // due, older

  const due = await store.listDuePending(now, 10)
  assert.deepEqual(
    due.map((j) => j.runId),
    [3, 1],
  )
})

test('listDuePending excludes jobs already marked resolving/completed/failed even if still in range', async () => {
  const { store } = makeStore()
  await store.upsertPending(baseInput({ runId: 1 }))
  await store.markResolving('CMS', 1)
  const due = await store.listDuePending(Date.now() + 1000, 10)
  assert.equal(due.length, 0)
})
