import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac } from 'node:crypto'

process.env.GITHUB_TOKEN = 'test-token'
process.env.GITHUB_OWNER = 'nguyenvuhoang'
process.env.GITHUB_REPO = 'w4s'
process.env.GITHUB_WORKFLOW = 'build-o24.yml'
process.env.GITHUB_WEBHOOK_SECRET = 'test-webhook-secret'
process.env.CRON_SECRET = 'test-cron-secret'

const { handleGithubWorkflowRunWebhook } = await import('./github/webhookHandler')
const { handleReconcileSnapshotsCron } = await import('./snapshotReconciliationCron')
const { KvSnapshotJobStore } = await import('./snapshotJobStore')
const { InMemoryReleaseRepository } = await import('./releaseRepository')

// Same minimal mock KV (with sorted-set support) used in
// snapshotJobStore.test.ts / snapshotReconciliationCron.test.ts.
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

function sign(body: string): string {
  return `sha256=${createHmac('sha256', 'test-webhook-secret').update(body).digest('hex')}`
}

function makeWorkflowRunPayload(runId: number) {
  return JSON.stringify({
    action: 'completed',
    workflow_run: {
      id: runId,
      path: '.github/workflows/build-o24.yml',
      run_attempt: 1,
      head_branch: 'developer',
      head_sha: 'a'.repeat(40),
      status: 'completed',
      conclusion: 'success',
      html_url: `https://github.com/nguyenvuhoang/w4s/actions/runs/${runId}`,
      created_at: '2026-08-23T00:00:00Z',
      updated_at: '2026-08-23T00:05:00Z',
    },
    repository: { full_name: 'nguyenvuhoang/w4s' },
  })
}

test('full lifecycle: webhook exhausts immediate retries with digest still missing -> persists a durable job -> a LATER cron run resolves it into exactly one snapshot', async () => {
  const kv: MockKvStore = { strings: new Map(), zsets: new Map() }
  const config = { url: 'https://fake-kv.example.com', token: 'fake-token' }
  const jobStore = new KvSnapshotJobStore(config)
  const releaseRepo = new InMemoryReleaseRepository()
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const command = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ result: handleKvCommand(kv, command) }), { status: 200 })
  }) as typeof fetch

  try {
    // Step 1: webhook delivers a completed, successful run. Its own
    // immediate-retry helper is stubbed to simulate Docker Hub NEVER
    // resolving within the webhook's short retry window.
    const body = makeWorkflowRunPayload(7001)
    const webhookResult = await handleGithubWorkflowRunWebhook(
      body,
      { signature: sign(body), event: 'workflow_run' },
      {
        getBuildIntent: async () => ({ runId: 7001, service: 'CMS', branch: 'developer', tag: 'latest', requestedBy: 'tester', requestedAt: new Date().toISOString() }),
        createReleaseSnapshotWithRetry: async () => ({ outcome: 'digest_not_found' }),
        snapshotJobStore: jobStore,
      },
    )
    assert.equal(webhookResult.status, 200)
    assert.equal(webhookResult.body.outcome, 'digest_not_found')

    // The build's lifecycle must NOT be treated as over — a durable job now exists.
    const jobAfterWebhook = await jobStore.getJob('CMS', 7001)
    assert.ok(jobAfterWebhook, 'expected a pending job to have been persisted after the webhook gave up retrying')
    assert.equal(jobAfterWebhook.status, 'pending')
    assert.equal(await releaseRepo.getByRun(7001, 1), undefined) // sanity: no snapshot yet

    // Step 2: sometime later, a cron invocation finds the due job and this
    // time Docker Hub HAS indexed the digest.
    const cronResult = await handleReconcileSnapshotsCron('Bearer test-cron-secret', {
      snapshotJobStore: jobStore,
      createSnapshot: async (run, service, createdBy) =>
        releaseRepo
          .create({
            service,
            source: 'github-actions',
            branch: run.branch,
            commitSha: run.commitSha,
            githubRunId: run.runId,
            githubRunAttempt: run.runAttempt ?? 1,
            dockerRepository: 'vknighthub/ips_o24cms',
            repoDigest: `vknighthub/ips_o24cms@sha256:${'f'.repeat(64)}`,
            tag: 'latest',
            createdBy,
          })
          .then((result) => ({ outcome: 'created' as const, result })),
    })

    assert.deepEqual(cronResult.body, { status: 'ok', processed: 1, completed: 1, retried: 0, failed: 0 })

    const jobAfterCron = await jobStore.getJob('CMS', 7001)
    assert.equal(jobAfterCron?.status, 'completed')

    const snapshot = await releaseRepo.getByRun(7001, 1)
    assert.ok(snapshot)
    assert.equal(snapshot.repoDigest, `vknighthub/ips_o24cms@sha256:${'f'.repeat(64)}`)

    // Exactly one snapshot — never a second one from the webhook's earlier attempt.
    const allForService = await releaseRepo.list({ service: 'CMS' })
    assert.equal(allForService.items.filter((item) => item.githubRunId === 7001).length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})
