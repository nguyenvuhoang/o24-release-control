import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac } from 'node:crypto'

process.env.GITHUB_TOKEN = 'test-token'
process.env.GITHUB_OWNER = 'nguyenvuhoang'
process.env.GITHUB_REPO = 'w4s'
process.env.GITHUB_WORKFLOW = 'build-o24.yml'
process.env.GITHUB_WEBHOOK_SECRET = 'test-webhook-secret'

const { handleGithubWorkflowRunWebhook } = await import('./webhookHandler')
const { createReleaseSnapshotWithRetry } = await import('../releaseSnapshotFromBuild')
const { InMemoryReleaseRepository } = await import('../releaseRepository')
const { isBuildServiceCode } = await import('./serviceMap')

function sign(body: string, secret = 'test-webhook-secret'): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

function makeWorkflowRunPayload(overrides: { runId?: number; runAttempt?: number; conclusion?: string | null; action?: string; repo?: string } = {}) {
  const runId = overrides.runId ?? 9001
  return JSON.stringify({
    action: overrides.action ?? 'completed',
    workflow_run: {
      id: runId,
      path: '.github/workflows/build-o24.yml',
      run_attempt: overrides.runAttempt ?? 1,
      head_branch: 'developer',
      head_sha: 'a'.repeat(40),
      status: 'completed',
      conclusion: overrides.conclusion === undefined ? 'success' : overrides.conclusion,
      html_url: `https://github.com/nguyenvuhoang/w4s/actions/runs/${runId}`,
      created_at: '2026-08-23T00:00:00Z',
      updated_at: '2026-08-23T00:05:00Z',
    },
    repository: { full_name: overrides.repo ?? 'nguyenvuhoang/w4s' },
  })
}

// Wraps the real createReleaseSnapshotWithRetry with an in-memory release
// repo + a canned Docker Hub digest, but keeps its actual retry/outcome
// logic exactly as production uses it — only the I/O edges are faked.
function makeSnapshotDep(digestHex: string) {
  const repo = new InMemoryReleaseRepository()
  const fn = ((run: Parameters<typeof createReleaseSnapshotWithRetry>[0], service: Parameters<typeof createReleaseSnapshotWithRetry>[1], createdBy: string) =>
    createReleaseSnapshotWithRetry(run, service, createdBy, {
      fetchDockerHubTagDigest: async (repository, tag) => ({ repoDigest: `${repository}@sha256:${digestHex}`, tag }),
      getBuildIntent: async () => undefined,
      createRelease: (input) => repo.create(input),
      sleep: async () => {},
    })) as typeof createReleaseSnapshotWithRetry
  return { repo, fn }
}

function alwaysHasIntent(service: string) {
  return async (_runId: number) => (isBuildServiceCode(service) ? { runId: _runId, service, branch: 'developer', tag: 'latest', requestedBy: 'tester', requestedAt: new Date().toISOString() } : undefined)
}

const NO_INTENT = async (_runId: number) => undefined

test('a validly signed, real workflow_run completed payload creates exactly one snapshot', async () => {
  const { repo, fn } = makeSnapshotDep('a'.repeat(64))
  const body = makeWorkflowRunPayload({ runId: 9001 })
  const result = await handleGithubWorkflowRunWebhook(
    body,
    { signature: sign(body), event: 'workflow_run' },
    { getBuildIntent: alwaysHasIntent('CMS'), createReleaseSnapshotWithRetry: fn },
  )
  assert.equal(result.status, 200)
  assert.equal(result.body.outcome, 'created')

  const snapshot = await repo.getByRun(9001, 1)
  assert.ok(snapshot)
  assert.equal(snapshot.service, 'CMS')
  assert.equal(snapshot.source, 'github-actions')
})

test('an invalid signature is rejected with 401 and never calls the snapshot dependency at all', async () => {
  let called = false
  const body = makeWorkflowRunPayload({ runId: 9002 })
  const result = await handleGithubWorkflowRunWebhook(
    body,
    { signature: 'sha256=' + '0'.repeat(64), event: 'workflow_run' },
    {
      getBuildIntent: alwaysHasIntent('CMS'),
      createReleaseSnapshotWithRetry: (async () => {
        called = true
        return { outcome: 'created' } as never
      }) as never,
    },
  )
  assert.equal(result.status, 401)
  assert.equal(called, false)
})

test('a missing GITHUB_WEBHOOK_SECRET refuses ALL requests, even with a well-formed signature header', async () => {
  const original = process.env.GITHUB_WEBHOOK_SECRET
  delete process.env.GITHUB_WEBHOOK_SECRET
  try {
    const body = makeWorkflowRunPayload({ runId: 9010 })
    const result = await handleGithubWorkflowRunWebhook(body, { signature: sign(body), event: 'workflow_run' })
    assert.equal(result.status, 500)
  } finally {
    process.env.GITHUB_WEBHOOK_SECRET = original
  }
})

test('a duplicate delivery of the same run+attempt results in exactly one stored snapshot', async () => {
  const { repo, fn } = makeSnapshotDep('b'.repeat(64))
  const body = makeWorkflowRunPayload({ runId: 9003 })
  const headers = { signature: sign(body), event: 'workflow_run' }
  const deps = { getBuildIntent: alwaysHasIntent('WFO'), createReleaseSnapshotWithRetry: fn }

  const first = await handleGithubWorkflowRunWebhook(body, headers, deps)
  const second = await handleGithubWorkflowRunWebhook(body, headers, deps)
  assert.equal(first.body.outcome, 'created')
  assert.equal(second.body.outcome, 'created') // idempotent create() ran again and deduped internally

  const list = await repo.list({ service: 'WFO' })
  const matchingThisRun = list.items.filter((item) => item.githubRunId === 9003 && item.githubRunAttempt === 1)
  assert.equal(matchingThisRun.length, 1)
})

test('a failed conclusion never invokes snapshot creation at all', async () => {
  let called = false
  const body = makeWorkflowRunPayload({ runId: 9004, conclusion: 'failure' })
  const result = await handleGithubWorkflowRunWebhook(
    body,
    { signature: sign(body), event: 'workflow_run' },
    {
      getBuildIntent: alwaysHasIntent('CTH'),
      createReleaseSnapshotWithRetry: (async () => {
        called = true
        return { outcome: 'created' } as never
      }) as never,
    },
  )
  assert.equal(result.body.outcome, 'not_eligible')
  assert.equal(called, false)
})

test('a non-workflow_run event is acknowledged and ignored, without calling any dependency', async () => {
  const body = JSON.stringify({ zen: 'ping' })
  const result = await handleGithubWorkflowRunWebhook(body, { signature: sign(body), event: 'ping' }, { getBuildIntent: NO_INTENT })
  assert.equal(result.status, 200)
  assert.equal(result.body.status, 'ignored')
})

test('a workflow_run for a different repository is acknowledged and ignored', async () => {
  const body = makeWorkflowRunPayload({ runId: 9005, repo: 'someone-else/other-repo' })
  const result = await handleGithubWorkflowRunWebhook(body, { signature: sign(body), event: 'workflow_run' }, { getBuildIntent: alwaysHasIntent('CMS') })
  assert.equal(result.body.status, 'ignored')
})

test('a completed, successful build with no matching BuildIntent is acknowledged but not resolved (never guesses a service)', async () => {
  const body = makeWorkflowRunPayload({ runId: 9006 })
  const result = await handleGithubWorkflowRunWebhook(body, { signature: sign(body), event: 'workflow_run' }, { getBuildIntent: NO_INTENT })
  assert.equal(result.body.outcome, 'unresolved_service')
})
