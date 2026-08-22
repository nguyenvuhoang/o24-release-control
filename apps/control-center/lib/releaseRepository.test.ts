import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRegistryReleaseId,
  buildReleaseId,
  InMemoryReleaseRepository,
  InvalidReleaseInputError,
  ReleaseConflictError,
  type CreateReleaseInput,
} from './releaseRepository'

function makeInput(overrides: Partial<CreateReleaseInput> = {}): CreateReleaseInput {
  return {
    service: 'CMS',
    branch: 'developer',
    commitSha: 'a'.repeat(40),
    dockerRepository: 'vknighthub/ips_o24cms',
    repoDigest: `vknighthub/ips_o24cms@sha256:${'b'.repeat(64)}`,
    tag: 'latest',
    githubRunId: 1001,
    githubRunAttempt: 1,
    createdBy: 'alice',
    ...overrides,
  }
}

test('release id is deterministic from service, runId and runAttempt', () => {
  assert.equal(buildReleaseId('CMS', 42, 1), 'release:CMS:42:1')
  assert.equal(buildReleaseId('CMS', 42, 2), 'release:CMS:42:2')
  assert.equal(buildReleaseId('WFO', 42, 1), 'release:WFO:42:1')
})

test('create succeeds on first call and normalizes service to uppercase', async () => {
  const repo = new InMemoryReleaseRepository()
  const { record, deduped } = await repo.create(makeInput({ service: 'cms' }))
  assert.equal(deduped, false)
  assert.equal(record.id, 'release:CMS:1001:1')
  assert.equal(record.service, 'CMS')
})

test('create is idempotent: same id + same data returns the original record deduped', async () => {
  const repo = new InMemoryReleaseRepository()
  const first = await repo.create(makeInput())
  const second = await repo.create(makeInput())
  assert.equal(second.deduped, true)
  assert.equal(second.record.id, first.record.id)
  assert.equal(second.record.createdAt, first.record.createdAt)
})

test('create throws ReleaseConflictError on same id with different data, and never overwrites', async () => {
  const repo = new InMemoryReleaseRepository()
  const first = await repo.create(makeInput())

  await assert.rejects(
    () => repo.create(makeInput({ repoDigest: `vknighthub/ips_o24cms@sha256:${'c'.repeat(64)}` })),
    ReleaseConflictError,
  )

  const stillOriginal = await repo.getById(first.record.id)
  assert.equal(stillOriginal?.repoDigest, first.record.repoDigest)
})

test('getById returns the stored record', async () => {
  const repo = new InMemoryReleaseRepository()
  const { record } = await repo.create(makeInput())
  const found = await repo.getById(record.id)
  assert.deepEqual(found, record)
})

test('getById returns undefined for an unknown id', async () => {
  const repo = new InMemoryReleaseRepository()
  assert.equal(await repo.getById('release:CMS:999:1'), undefined)
})

test('getByRun looks up by runId + runAttempt without needing the id', async () => {
  const repo = new InMemoryReleaseRepository()
  const { record } = await repo.create(makeInput({ githubRunId: 555, githubRunAttempt: 2 }))
  const found = await repo.getByRun(555, 2)
  assert.deepEqual(found, record)
  assert.equal(await repo.getByRun(555, 1), undefined)
})

test('list returns newest-first across all services', async () => {
  const repo = new InMemoryReleaseRepository()
  await repo.create(makeInput({ service: 'CMS', githubRunId: 1, githubRunAttempt: 1 }))
  await new Promise((resolve) => setTimeout(resolve, 2))
  await repo.create(makeInput({ service: 'WFO', githubRunId: 2, githubRunAttempt: 1 }))
  await new Promise((resolve) => setTimeout(resolve, 2))
  await repo.create(makeInput({ service: 'CMS', githubRunId: 3, githubRunAttempt: 1 }))

  const { items } = await repo.list()
  assert.deepEqual(
    items.map((item) => item.githubRunId),
    [3, 2, 1],
  )
})

test('list filters by service and preserves newest-first order', async () => {
  const repo = new InMemoryReleaseRepository()
  await repo.create(makeInput({ service: 'CMS', githubRunId: 1, githubRunAttempt: 1 }))
  await new Promise((resolve) => setTimeout(resolve, 2))
  await repo.create(makeInput({ service: 'WFO', githubRunId: 2, githubRunAttempt: 1 }))
  await new Promise((resolve) => setTimeout(resolve, 2))
  await repo.create(makeInput({ service: 'CMS', githubRunId: 3, githubRunAttempt: 1 }))

  const { items } = await repo.list({ service: 'CMS' })
  assert.deepEqual(
    items.map((item) => item.githubRunId),
    [3, 1],
  )
  assert.ok(items.every((item) => item.service === 'CMS'))
})

test('list paginates via cursor', async () => {
  const repo = new InMemoryReleaseRepository()
  for (let i = 1; i <= 5; i += 1) {
    await repo.create(makeInput({ githubRunId: i, githubRunAttempt: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 2))
  }

  const page1 = await repo.list({ limit: 2 })
  assert.deepEqual(page1.items.map((item) => item.githubRunId), [5, 4])
  assert.ok(page1.nextCursor)

  const page2 = await repo.list({ limit: 2, cursor: page1.nextCursor })
  assert.deepEqual(page2.items.map((item) => item.githubRunId), [3, 2])
  assert.ok(page2.nextCursor)

  const page3 = await repo.list({ limit: 2, cursor: page2.nextCursor })
  assert.deepEqual(page3.items.map((item) => item.githubRunId), [1])
  assert.equal(page3.nextCursor, undefined)
})

test('rejects a repoDigest that is a mutable tag or a local imageId, not repository@sha256:<64 hex>', async () => {
  const repo = new InMemoryReleaseRepository()
  await assert.rejects(() => repo.create(makeInput({ repoDigest: 'vknighthub/ips_o24cms:latest' })), InvalidReleaseInputError)
  await assert.rejects(() => repo.create(makeInput({ repoDigest: 'sha256:' + 'a'.repeat(64) })), InvalidReleaseInputError)
  await assert.rejects(() => repo.create(makeInput({ repoDigest: '3f1a2b9c8d7e' })), InvalidReleaseInputError)
})

test('rejects a non-integer or non-positive githubRunId/githubRunAttempt', async () => {
  const repo = new InMemoryReleaseRepository()
  await assert.rejects(() => repo.create(makeInput({ githubRunId: 0 })), InvalidReleaseInputError)
  await assert.rejects(() => repo.create(makeInput({ githubRunId: 1.5 })), InvalidReleaseInputError)
  await assert.rejects(() => repo.create(makeInput({ githubRunId: -1 })), InvalidReleaseInputError)
  await assert.rejects(() => repo.create(makeInput({ githubRunAttempt: 0 })), InvalidReleaseInputError)
})

test('rejects a commitSha that is not a valid 40-character hex Git SHA', async () => {
  const repo = new InMemoryReleaseRepository()
  await assert.rejects(() => repo.create(makeInput({ commitSha: 'not-a-sha' })), InvalidReleaseInputError)
  await assert.rejects(() => repo.create(makeInput({ commitSha: 'a'.repeat(39) })), InvalidReleaseInputError)
})

test('rejects an unknown service code', async () => {
  const repo = new InMemoryReleaseRepository()
  await assert.rejects(() => repo.create(makeInput({ service: 'NOPE' })), InvalidReleaseInputError)
})

test('registry release id is deterministic from the digest itself, not a run', () => {
  const digest = `sha256:${'c'.repeat(64)}`
  assert.equal(buildRegistryReleaseId('CMS', `vknighthub/ips_o24cms@${digest}`), `release:CMS:digest:${'c'.repeat(64)}`)
  assert.equal(
    buildRegistryReleaseId('CMS', `vknighthub/ips_o24cms@${digest}`),
    buildRegistryReleaseId('CMS', `some/other/repo@${digest}`),
  )
})

function makeRegistryInput(overrides: Partial<CreateReleaseInput> = {}): CreateReleaseInput {
  return {
    service: 'CMS',
    source: 'docker-registry',
    dockerRepository: 'vknighthub/ips_o24cms',
    repoDigest: `vknighthub/ips_o24cms@sha256:${'d'.repeat(64)}`,
    tag: 'latest',
    createdBy: 'bob',
    discoveredAt: '2026-08-22T00:00:00.000Z',
    ...overrides,
  }
}

test('a docker-registry release has no build to point to — branch/commitSha/runId/runAttempt stay null', async () => {
  const repo = new InMemoryReleaseRepository()
  const { record } = await repo.create(makeRegistryInput())
  assert.equal(record.source, 'docker-registry')
  assert.equal(record.branch, null)
  assert.equal(record.commitSha, null)
  assert.equal(record.githubRunId, null)
  assert.equal(record.githubRunAttempt, null)
  assert.equal(record.id, buildRegistryReleaseId('CMS', record.repoDigest))
})

test('re-syncing the same Docker Hub digest dedupes instead of creating a second release', async () => {
  const repo = new InMemoryReleaseRepository()
  const first = await repo.create(makeRegistryInput())
  const second = await repo.create(makeRegistryInput({ discoveredAt: '2026-08-22T01:00:00.000Z' }))
  assert.equal(second.deduped, true)
  assert.equal(second.record.id, first.record.id)
  assert.equal(second.record.discoveredAt, first.record.discoveredAt)
})

test('a genuinely new Docker Hub digest for the same service gets its own release, not a conflict', async () => {
  const repo = new InMemoryReleaseRepository()
  const first = await repo.create(makeRegistryInput())
  const second = await repo.create(
    makeRegistryInput({ repoDigest: `vknighthub/ips_o24cms@sha256:${'e'.repeat(64)}` }),
  )
  assert.notEqual(second.record.id, first.record.id)
  assert.equal(second.deduped, false)
})

test('github-actions releases still require branch, commitSha, githubRunId and githubRunAttempt', async () => {
  const repo = new InMemoryReleaseRepository()
  await assert.rejects(() => repo.create(makeInput({ branch: null })), InvalidReleaseInputError)
  await assert.rejects(() => repo.create(makeInput({ commitSha: null })), InvalidReleaseInputError)
  await assert.rejects(() => repo.create(makeInput({ githubRunId: null })), InvalidReleaseInputError)
  await assert.rejects(() => repo.create(makeInput({ githubRunAttempt: null })), InvalidReleaseInputError)
})
