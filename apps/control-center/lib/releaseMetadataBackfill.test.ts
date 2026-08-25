import assert from 'node:assert/strict'
import test from 'node:test'
import { backfillAllReleaseMetadata, backfillReleaseMetadata } from './releaseMetadataBackfill'
import type { ReleaseMetadataPatch } from './releaseRepository'
import type { ReleaseSnapshot } from './types'

const REPO = 'vknighthub/ips_o24cms'

function makeRelease(overrides: Partial<ReleaseSnapshot> = {}): ReleaseSnapshot {
  return {
    id: 'release:CMS:1:1',
    service: 'CMS',
    source: 'github-actions',
    branch: 'developer',
    commitSha: null,
    commitMessage: null,
    dockerRepository: REPO,
    repoDigest: `${REPO}@sha256:${'a'.repeat(64)}`,
    tag: 'latest',
    githubRunId: 1001,
    githubRunAttempt: 1,
    createdAt: '2026-08-22T00:00:00.000Z',
    createdBy: 'admin',
    ...overrides,
  }
}

// A tiny in-memory fake honoring the SAME "fill only missing, never
// overwrite" contract releaseRepository.ts enforces for real — so these
// tests also catch a backfill orchestration bug that would otherwise try to
// clobber an existing value (the fake doesn't blindly trust the patch).
function makeFakeUpdateMetadata(store: Map<string, ReleaseSnapshot>) {
  return async (id: string, patch: ReleaseMetadataPatch): Promise<ReleaseSnapshot | undefined> => {
    const existing = store.get(id)
    if (!existing) return undefined
    const next = { ...existing }
    if (!next.commitSha && patch.commitSha) next.commitSha = patch.commitSha
    if (!next.commitMessage && patch.commitMessage) next.commitMessage = patch.commitMessage
    store.set(id, next)
    return next
  }
}

// ---- backfillReleaseMetadata (single release) ----

test('already-complete release is skipped without calling any lookup', async () => {
  const release = makeRelease({ commitSha: 'a'.repeat(40), commitMessage: 'feat: already here' })
  const outcome = await backfillReleaseMetadata(release, {
    getWorkflowRun: async () => {
      throw new Error('must never be called')
    },
    getCommitMessage: async () => {
      throw new Error('must never be called')
    },
  })
  assert.deepEqual(outcome, { outcome: 'skipped_complete', record: release })
})

test('github-actions: missing commitSha resolves via githubRunId, then resolves commitMessage from it', async () => {
  const release = makeRelease({ commitSha: null, commitMessage: null, githubRunId: 4242, githubRunAttempt: 1 })
  const store = new Map([[release.id, release]])
  let runIdRequested: number | undefined
  let shaRequestedForMessage: string | undefined

  const outcome = await backfillReleaseMetadata(release, {
    getWorkflowRun: async (runId) => {
      runIdRequested = runId
      return { commitSha: 'b'.repeat(40) }
    },
    getCommitMessage: async (sha) => {
      shaRequestedForMessage = sha
      return 'feat: implement SimpleSearchResidents feature'
    },
    updateMetadata: makeFakeUpdateMetadata(store),
  })

  assert.equal(runIdRequested, 4242)
  assert.equal(shaRequestedForMessage, 'b'.repeat(40))
  assert.ok(outcome.outcome === 'updated')
  assert.deepEqual(outcome.filled.sort(), ['commitMessage', 'commitSha'])
  assert.equal(outcome.record.commitSha, 'b'.repeat(40))
  assert.equal(outcome.record.commitMessage, 'feat: implement SimpleSearchResidents feature')
})

test('github-actions: commitSha already stored is used directly — githubRunId lookup is never called', async () => {
  const release = makeRelease({ commitSha: 'c'.repeat(40), commitMessage: null })
  const store = new Map([[release.id, release]])

  const outcome = await backfillReleaseMetadata(release, {
    getWorkflowRun: async () => {
      throw new Error('must never be called — commitSha is already stored')
    },
    getCommitMessage: async (sha) => {
      assert.equal(sha, 'c'.repeat(40))
      return 'feat: use the stored sha directly'
    },
    updateMetadata: makeFakeUpdateMetadata(store),
  })

  assert.ok(outcome.outcome === 'updated')
  assert.deepEqual(outcome.filled, ['commitMessage'])
  assert.equal(outcome.record.commitSha, 'c'.repeat(40))
})

test('docker-registry: missing commitSha resolves via the OCI revision label, then commit message', async () => {
  const release = makeRelease({ source: 'docker-registry', branch: null, commitSha: null, commitMessage: null, githubRunId: null, githubRunAttempt: null })
  const store = new Map([[release.id, release]])
  let labelRequestedFor: { repository: string; repoDigest: string } | undefined

  const outcome = await backfillReleaseMetadata(release, {
    fetchImageRevisionLabel: async (repository, repoDigest) => {
      labelRequestedFor = { repository, repoDigest }
      return 'd'.repeat(40)
    },
    getCommitMessage: async () => 'feat: resolved from OCI label',
    updateMetadata: makeFakeUpdateMetadata(store),
  })

  assert.deepEqual(labelRequestedFor, { repository: REPO, repoDigest: release.repoDigest })
  assert.ok(outcome.outcome === 'updated')
  assert.equal(outcome.record.commitSha, 'd'.repeat(40))
  assert.equal(outcome.record.commitMessage, 'feat: resolved from OCI label')
})

test('docker-registry: no OCI revision label found leaves the release unresolved — never guesses', async () => {
  const release = makeRelease({ source: 'docker-registry', branch: null, commitSha: null, commitMessage: null, githubRunId: null, githubRunAttempt: null })

  const outcome = await backfillReleaseMetadata(release, {
    fetchImageRevisionLabel: async () => null,
    getCommitMessage: async () => {
      throw new Error('must never be called — no sha to resolve a message for')
    },
  })

  assert.deepEqual(outcome, { outcome: 'unresolved', record: release })
})

test('docker-registry: an invalid (non-40-hex) revision label is discarded, not stored', async () => {
  const release = makeRelease({ source: 'docker-registry', branch: null, commitSha: null, commitMessage: null, githubRunId: null, githubRunAttempt: null })

  const outcome = await backfillReleaseMetadata(release, {
    fetchImageRevisionLabel: async () => 'not-a-real-sha',
  })

  assert.deepEqual(outcome, { outcome: 'unresolved', record: release })
})

test('a lookup failure never throws — it just leaves that field unresolved for this run', async () => {
  const release = makeRelease({ commitSha: null, commitMessage: null })
  const outcome = await backfillReleaseMetadata(release, {
    getWorkflowRun: async () => {
      throw new Error('GitHub API 500: boom')
    },
  })
  assert.deepEqual(outcome, { outcome: 'unresolved', record: release })
})

test('updateMetadata never overwrites a pre-existing commitMessage, even when the resolver returns a different one', async () => {
  const release = makeRelease({ commitSha: null, commitMessage: 'feat: original message, must survive' })
  const store = new Map([[release.id, release]])

  const outcome = await backfillReleaseMetadata(release, {
    getWorkflowRun: async () => ({ commitSha: 'e'.repeat(40) }),
    getCommitMessage: async () => 'feat: a DIFFERENT message that must never be stored',
    updateMetadata: makeFakeUpdateMetadata(store),
  })

  assert.ok(outcome.outcome === 'updated')
  assert.deepEqual(outcome.filled, ['commitSha']) // commitMessage was already set, so it's not in `filled`
  assert.equal(outcome.record.commitMessage, 'feat: original message, must survive')
})

// ---- backfillAllReleaseMetadata (bulk) ----

test('bulk backfill scans only releases missing a field, skips complete ones, and aggregates a summary', async () => {
  const complete = makeRelease({ id: 'release:CMS:1:1', commitSha: 'a'.repeat(40), commitMessage: 'feat: complete' })
  const missingMessage = makeRelease({ id: 'release:CMS:2:1', githubRunId: 2, commitSha: 'b'.repeat(40), commitMessage: null })
  const missingBoth = makeRelease({ id: 'release:CMS:3:1', githubRunId: 3, commitSha: null, commitMessage: null })
  const store = new Map([complete, missingMessage, missingBoth].map((release) => [release.id, release]))

  const summary = await backfillAllReleaseMetadata({
    listReleases: async () => ({ items: [complete, missingMessage, missingBoth] }),
    getWorkflowRun: async (runId) => ({ commitSha: runId === 3 ? 'c'.repeat(40) : 'unused' }),
    getCommitMessage: async () => 'feat: resolved in bulk',
    updateMetadata: makeFakeUpdateMetadata(store),
  })

  assert.equal(summary.scanned, 2) // complete is never even a candidate
  assert.equal(summary.updated, 2)
  assert.equal(summary.unresolved, 0)
  assert.equal(store.get('release:CMS:1:1')?.commitMessage, 'feat: complete') // untouched
  assert.equal(store.get('release:CMS:2:1')?.commitMessage, 'feat: resolved in bulk')
  assert.equal(store.get('release:CMS:3:1')?.commitSha, 'c'.repeat(40))
})

test('bulk backfill respects `limit` — stops collecting candidates once reached, even across pages', async () => {
  const releases = Array.from({ length: 5 }, (_, i) =>
    makeRelease({ id: `release:CMS:${i}:1`, githubRunId: i, commitSha: null, commitMessage: null }),
  )
  const pages = [releases.slice(0, 3), releases.slice(3)]
  let pageIndex = 0
  const store = new Map(releases.map((release) => [release.id, release]))

  const summary = await backfillAllReleaseMetadata({
    limit: 2,
    listReleases: async () => {
      const items = pages[pageIndex] ?? []
      pageIndex += 1
      return { items, nextCursor: pageIndex < pages.length ? String(pageIndex) : undefined }
    },
    getWorkflowRun: async () => ({ commitSha: 'a'.repeat(40) }),
    getCommitMessage: async () => 'feat: x',
    updateMetadata: makeFakeUpdateMetadata(store),
  })

  assert.equal(summary.scanned, 2)
  assert.equal(summary.updated + summary.unresolved, 2)
})

test('bulk backfill with `service` filter is passed straight through to listReleases', async () => {
  let requestedService: string | undefined
  const summary = await backfillAllReleaseMetadata({
    service: 'WFO',
    listReleases: async (query) => {
      requestedService = query.service
      return { items: [] }
    },
  })
  assert.equal(requestedService, 'WFO')
  assert.equal(summary.scanned, 0)
})
