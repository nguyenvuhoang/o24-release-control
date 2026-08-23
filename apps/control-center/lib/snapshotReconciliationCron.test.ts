import assert from 'node:assert/strict'
import test from 'node:test'

process.env.CRON_SECRET = 'test-cron-secret'

const { handleReconcileSnapshotsCron } = await import('./snapshotReconciliationCron')
const { MAX_RECONCILE_ATTEMPTS } = await import('./snapshotReconciliation')
const { InMemoryReleaseRepository } = await import('./releaseRepository')
const { KvSnapshotJobStore } = await import('./snapshotJobStore')

// Reuse the same lightweight mock KV (with sorted-set support) as
// snapshotJobStore.test.ts, kept local since only this file needs it.
type MockKvStore = { strings: Map<string, string>; zsets: Map<string, Map<string, number>> }

function handleKvCommand(store: MockKvStore, command: unknown[]): unknown {
  const [op, ...args] = command as (string | number)[]
  if (op === 'GET') return store.strings.has(String(args[0])) ? store.strings.get(String(args[0])) : null
  if (op === 'SET') {
    store.strings.set(String(args[0]), String(args[1]))
    return 'OK'
  }
  if (op === 'MGET') return args.map((key) => (store.strings.has(String(key)) ? store.strings.get(String(key)) : null))
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

function makeJobStore(): { jobStore: InstanceType<typeof KvSnapshotJobStore>; kv: MockKvStore } {
  const kv: MockKvStore = { strings: new Map(), zsets: new Map() }
  const config = { url: 'https://fake-kv.example.com', token: 'fake-token' }
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const command = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ result: handleKvCommand(kv, command) }), { status: 200 })
  }) as typeof fetch
  test.after(() => {
    globalThis.fetch = originalFetch
  })
  return { jobStore: new KvSnapshotJobStore(config), kv }
}

test('missing CRON_SECRET refuses to run (500), regardless of auth header', async () => {
  const original = process.env.CRON_SECRET
  delete process.env.CRON_SECRET
  try {
    const result = await handleReconcileSnapshotsCron('Bearer anything')
    assert.equal(result.status, 500)
  } finally {
    process.env.CRON_SECRET = original
  }
})

test('a missing or wrong Authorization header is rejected with 401', async () => {
  assert.equal((await handleReconcileSnapshotsCron(null)).status, 401)
  assert.equal((await handleReconcileSnapshotsCron('Bearer wrong-secret')).status, 401)
})

test('a correct Authorization header with no due jobs processes zero jobs', async () => {
  const { jobStore } = makeJobStore()
  const result = await handleReconcileSnapshotsCron('Bearer test-cron-secret', { snapshotJobStore: jobStore })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { status: 'ok', processed: 0, completed: 0, retried: 0, failed: 0 })
})

test('a due job whose digest is STILL not found gets rescheduled with exponential backoff, not marked failed', async () => {
  const { jobStore } = makeJobStore()
  await jobStore.upsertPending({ service: 'CMS', runId: 6001, runAttempt: 1, branch: 'developer', commitSha: 'a'.repeat(40), htmlUrl: 'x', createdBySource: 'github-webhook' })
  await jobStore.markRetry('CMS', 6001, 'digest_not_found', new Date(Date.now() - 1000).toISOString()) // now due, attemptCount=1

  const result = await handleReconcileSnapshotsCron('Bearer test-cron-secret', {
    snapshotJobStore: jobStore,
    createSnapshot: async () => ({ outcome: 'digest_not_found' }),
  })
  assert.deepEqual(result.body, { status: 'ok', processed: 1, completed: 0, retried: 1, failed: 0 })

  const job = await jobStore.getJob('CMS', 6001)
  assert.equal(job?.status, 'pending')
  assert.equal(job?.attemptCount, 2)
})

test('a due job whose digest is now available creates exactly one snapshot and marks the job completed', async () => {
  const { jobStore } = makeJobStore()
  const repo = new InMemoryReleaseRepository()
  await jobStore.upsertPending({ service: 'CMS', runId: 6002, runAttempt: 1, branch: 'developer', commitSha: 'a'.repeat(40), htmlUrl: 'x', createdBySource: 'github-webhook' })
  await jobStore.markRetry('CMS', 6002, 'digest_not_found', new Date(Date.now() - 1000).toISOString())

  const result = await handleReconcileSnapshotsCron('Bearer test-cron-secret', {
    snapshotJobStore: jobStore,
    createSnapshot: async (run, service, createdBy) =>
      repo
        .create({
          service,
          source: 'github-actions',
          branch: run.branch,
          commitSha: run.commitSha,
          githubRunId: run.runId,
          githubRunAttempt: run.runAttempt ?? 1,
          dockerRepository: 'vknighthub/ips_o24cms',
          repoDigest: `vknighthub/ips_o24cms@sha256:${'a'.repeat(64)}`,
          tag: 'latest',
          createdBy,
        })
        .then((result) => ({ outcome: 'created' as const, result })),
  })
  assert.deepEqual(result.body, { status: 'ok', processed: 1, completed: 1, retried: 0, failed: 0 })

  const job = await jobStore.getJob('CMS', 6002)
  assert.equal(job?.status, 'completed')
  assert.ok(job?.releaseId)

  const snapshot = await repo.getByRun(6002, 1)
  assert.ok(snapshot)
})

test('a job that exceeds MAX_RECONCILE_ATTEMPTS is marked failed and removed from the pending queue', async () => {
  const { jobStore } = makeJobStore()
  await jobStore.upsertPending({ service: 'CMS', runId: 6003, runAttempt: 1, branch: 'developer', commitSha: 'a'.repeat(40), htmlUrl: 'x', createdBySource: 'github-webhook' })
  // Fast-forward attemptCount to just below the max via direct markRetry calls.
  for (let i = 0; i < MAX_RECONCILE_ATTEMPTS - 1; i += 1) {
    await jobStore.markRetry('CMS', 6003, 'digest_not_found', new Date(Date.now() - 1000).toISOString())
  }
  const before = await jobStore.getJob('CMS', 6003)
  assert.equal(before?.attemptCount, MAX_RECONCILE_ATTEMPTS - 1)

  const result = await handleReconcileSnapshotsCron('Bearer test-cron-secret', {
    snapshotJobStore: jobStore,
    createSnapshot: async () => ({ outcome: 'digest_not_found' }),
  })
  assert.deepEqual(result.body, { status: 'ok', processed: 1, completed: 0, retried: 0, failed: 1 })

  const after = await jobStore.getJob('CMS', 6003)
  assert.equal(after?.status, 'failed')
})

test('a job past MAX_RECONCILE_AGE_MS is marked failed immediately, without attempting a snapshot lookup', async () => {
  const { jobStore, kv } = makeJobStore()
  const job = await jobStore.upsertPending({ service: 'CMS', runId: 6004, runAttempt: 1, branch: 'developer', commitSha: 'a'.repeat(40), htmlUrl: 'x', createdBySource: 'github-webhook' })
  // Backdate createdAt directly in the mock store to simulate an old job, then make it due.
  const raw = JSON.parse(kv.strings.get(`o24:snapshot-job:record:${job.id}`)!)
  raw.createdAt = new Date(0).toISOString()
  kv.strings.set(`o24:snapshot-job:record:${job.id}`, JSON.stringify(raw))
  await jobStore.markRetry('CMS', 6004, 'digest_not_found', new Date(Date.now() - 1000).toISOString())

  let snapshotCalled = false
  const result = await handleReconcileSnapshotsCron('Bearer test-cron-secret', {
    snapshotJobStore: jobStore,
    createSnapshot: async () => {
      snapshotCalled = true
      return { outcome: 'digest_not_found' }
    },
  })
  assert.equal(snapshotCalled, false)
  assert.deepEqual(result.body, { status: 'ok', processed: 1, completed: 0, retried: 0, failed: 1 })
})

test('a job that resolves to conflict is marked failed terminally, not retried', async () => {
  const { jobStore } = makeJobStore()
  await jobStore.upsertPending({ service: 'CMS', runId: 6005, runAttempt: 1, branch: 'developer', commitSha: 'a'.repeat(40), htmlUrl: 'x', createdBySource: 'github-webhook' })
  await jobStore.markRetry('CMS', 6005, 'digest_not_found', new Date(Date.now() - 1000).toISOString())

  const result = await handleReconcileSnapshotsCron('Bearer test-cron-secret', {
    snapshotJobStore: jobStore,
    createSnapshot: async () => ({ outcome: 'conflict', releaseId: 'release:CMS:6005:1' }),
  })
  assert.deepEqual(result.body, { status: 'ok', processed: 1, completed: 0, retried: 0, failed: 1 })
  const job = await jobStore.getJob('CMS', 6005)
  assert.equal(job?.status, 'failed')
})
