import assert from 'node:assert/strict'
import test from 'node:test'
import { createReleaseSnapshotForCompletedBuild, createReleaseSnapshotWithRetry } from './releaseSnapshotFromBuild'
import { InMemoryReleaseRepository } from './releaseRepository'
import type { BuildIntent, BuildRunSnapshot, DockerHubTagInfo } from './types'

function makeRun(overrides: Partial<BuildRunSnapshot> = {}): BuildRunSnapshot {
  return {
    runId: 1001,
    status: 'completed',
    conclusion: 'success',
    htmlUrl: 'https://github.com/x/y/actions/runs/1001',
    branch: 'developer',
    commitSha: 'a'.repeat(40),
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:05:00.000Z',
    runAttempt: 1,
    ...overrides,
  }
}

function stubDockerHub(digestHex: string): (repository: string, tag: string) => Promise<DockerHubTagInfo | null> {
  return async (repository, tag) => ({ repoDigest: `${repository}@sha256:${digestHex}`, tag })
}

function stubNoDockerHubDigest(): (repository: string, tag: string) => Promise<DockerHubTagInfo | null> {
  return async () => null
}

function stubNoBuildIntent(): (runId: number) => Promise<BuildIntent | undefined> {
  return async () => undefined
}

function stubNoCommitMessage(): (sha: string) => Promise<string | null> {
  return async () => null
}

function makeHarness(digestHex: string) {
  const repo = new InMemoryReleaseRepository()
  return {
    repo,
    options: {
      fetchDockerHubTagDigest: stubDockerHub(digestHex),
      getBuildIntent: stubNoBuildIntent(),
      getCommitMessage: stubNoCommitMessage(),
      createRelease: (input: Parameters<InMemoryReleaseRepository['create']>[0]) => repo.create(input),
    },
  }
}

test('a completed, successful run creates exactly one github-actions ReleaseSnapshot with an immutable repoDigest', async () => {
  const { repo, options } = makeHarness('a'.repeat(64))
  const run = makeRun({ runId: 2001 })
  const outcome = await createReleaseSnapshotForCompletedBuild(run, 'CMS', 'tester', options)

  assert.equal(outcome.outcome, 'created')
  assert.ok(outcome.outcome === 'created')
  assert.equal(outcome.result.deduped, false)
  assert.equal(outcome.result.record.source, 'github-actions')
  assert.equal(outcome.result.record.repoDigest, `vknighthub/ips_o24cms@sha256:${'a'.repeat(64)}`)
  assert.equal(outcome.result.record.githubRunId, 2001)
  assert.equal(outcome.result.record.githubRunAttempt, 1)

  const stored = await repo.getByRun(2001, 1)
  assert.ok(stored)
  assert.equal(stored.repoDigest, outcome.result.record.repoDigest)
})

test('a run still in progress is not_eligible — no throw, no network call needed', async () => {
  const { options } = makeHarness('a'.repeat(64))
  const run = makeRun({ status: 'in_progress', conclusion: null })
  const outcome = await createReleaseSnapshotForCompletedBuild(run, 'CMS', 'tester', options)
  assert.deepEqual(outcome, { outcome: 'not_eligible' })
})

test('a completed but FAILED run is not_eligible — never creates a snapshot', async () => {
  const { repo, options } = makeHarness('a'.repeat(64))
  const run = makeRun({ runId: 2002, status: 'completed', conclusion: 'failure' })
  const outcome = await createReleaseSnapshotForCompletedBuild(run, 'CMS', 'tester', options)
  assert.deepEqual(outcome, { outcome: 'not_eligible' })
  assert.equal(await repo.getByRun(2002, 1), undefined)
})

test('a completed but CANCELLED run is not_eligible — never creates a snapshot', async () => {
  const { repo, options } = makeHarness('a'.repeat(64))
  const run = makeRun({ runId: 2003, status: 'completed', conclusion: 'cancelled' })
  const outcome = await createReleaseSnapshotForCompletedBuild(run, 'CMS', 'tester', options)
  assert.deepEqual(outcome, { outcome: 'not_eligible' })
  assert.equal(await repo.getByRun(2003, 1), undefined)
})

test('a completed but TIMED_OUT run is not_eligible — never creates a snapshot', async () => {
  const { repo, options } = makeHarness('a'.repeat(64))
  const run = makeRun({ runId: 2009, status: 'completed', conclusion: 'timed_out' })
  const outcome = await createReleaseSnapshotForCompletedBuild(run, 'CMS', 'tester', options)
  assert.deepEqual(outcome, { outcome: 'not_eligible' })
  assert.equal(await repo.getByRun(2009, 1), undefined)
})

test('polling/delivering the same completed run+attempt twice dedupes instead of creating a duplicate snapshot', async () => {
  const { options } = makeHarness('b'.repeat(64))
  const run = makeRun({ runId: 2004 })
  const first = await createReleaseSnapshotForCompletedBuild(run, 'CMS', 'tester', options)
  const second = await createReleaseSnapshotForCompletedBuild(run, 'CMS', 'tester', options)
  assert.ok(first.outcome === 'created' && second.outcome === 'created')
  assert.equal(first.result.record.id, second.result.record.id)
  assert.equal(second.result.deduped, true)
})

test('a retry (different runAttempt) that succeeds gets its own independent snapshot', async () => {
  const { options } = makeHarness('c'.repeat(64))
  const attempt1 = await createReleaseSnapshotForCompletedBuild(makeRun({ runId: 2005, runAttempt: 1 }), 'CMS', 'tester', options)
  const attempt2 = await createReleaseSnapshotForCompletedBuild(makeRun({ runId: 2005, runAttempt: 2 }), 'CMS', 'tester', options)
  assert.ok(attempt1.outcome === 'created' && attempt2.outcome === 'created')
  assert.notEqual(attempt1.result.record.id, attempt2.result.record.id)
  assert.equal(attempt2.result.deduped, false)
})

test('batch build gives each service its own snapshot for the same conceptual build wave', async () => {
  const { options } = makeHarness('d'.repeat(64))
  const cms = await createReleaseSnapshotForCompletedBuild(makeRun({ runId: 3001 }), 'CMS', 'tester', options)
  const wfo = await createReleaseSnapshotForCompletedBuild(makeRun({ runId: 3002 }), 'WFO', 'tester', options)
  assert.ok(cms.outcome === 'created' && wfo.outcome === 'created')
  assert.notEqual(cms.result.record.id, wfo.result.record.id)
  assert.equal(cms.result.record.service, 'CMS')
  assert.equal(wfo.result.record.service, 'WFO')
})

test('a resolved commit message is stored on the created ReleaseSnapshot', async () => {
  const { options } = makeHarness('a'.repeat(64))
  const withCommitMessage = { ...options, getCommitMessage: async (sha: string) => (sha === 'a'.repeat(40) ? 'feat: implement SimpleSearchResidents feature' : null) }
  const outcome = await createReleaseSnapshotForCompletedBuild(makeRun({ runId: 2010 }), 'CMS', 'tester', withCommitMessage)
  assert.ok(outcome.outcome === 'created')
  assert.equal(outcome.result.record.commitMessage, 'feat: implement SimpleSearchResidents feature')
})

test('a commit message lookup failure never blocks snapshot creation — commitMessage just stays null', async () => {
  const { options } = makeHarness('a'.repeat(64))
  const failingLookup = { ...options, getCommitMessage: async () => { throw new Error('GitHub API 500: boom') } }
  const outcome = await createReleaseSnapshotForCompletedBuild(makeRun({ runId: 2011 }), 'CMS', 'tester', failingLookup)
  assert.ok(outcome.outcome === 'created')
  assert.equal(outcome.result.record.commitMessage, null)
})

test('no Docker Hub digest found (yet) returns digest_not_found — never throws, never creates', async () => {
  const repo = new InMemoryReleaseRepository()
  const options = {
    fetchDockerHubTagDigest: stubNoDockerHubDigest(),
    getBuildIntent: stubNoBuildIntent(),
    createRelease: (input: Parameters<InMemoryReleaseRepository['create']>[0]) => repo.create(input),
  }
  const outcome = await createReleaseSnapshotForCompletedBuild(makeRun({ runId: 2006 }), 'CMS', 'tester', options)
  assert.deepEqual(outcome, { outcome: 'digest_not_found' })
})

test('uses the tag recorded in the BuildIntent for this runId, not a hardcoded default', async () => {
  const repo = new InMemoryReleaseRepository()
  let requestedTag: string | undefined
  const options = {
    fetchDockerHubTagDigest: async (repository: string, tag: string) => {
      requestedTag = tag
      return { repoDigest: `${repository}@sha256:${'e'.repeat(64)}`, tag }
    },
    getBuildIntent: async (runId: number): Promise<BuildIntent | undefined> =>
      runId === 2007 ? { runId: 2007, service: 'CMS', branch: 'developer', tag: 'v1.2.3', requestedBy: 'tester', requestedAt: new Date().toISOString() } : undefined,
    getCommitMessage: stubNoCommitMessage(),
    createRelease: (input: Parameters<InMemoryReleaseRepository['create']>[0]) => repo.create(input),
  }
  await createReleaseSnapshotForCompletedBuild(makeRun({ runId: 2007 }), 'CMS', 'tester', options)
  assert.equal(requestedTag, 'v1.2.3')
})

test('falls back to "latest" when no BuildIntent exists for this runId (build not dispatched by this app)', async () => {
  const repo = new InMemoryReleaseRepository()
  let requestedTag: string | undefined
  const options = {
    fetchDockerHubTagDigest: async (repository: string, tag: string) => {
      requestedTag = tag
      return { repoDigest: `${repository}@sha256:${'f'.repeat(64)}`, tag }
    },
    getBuildIntent: stubNoBuildIntent(),
    getCommitMessage: stubNoCommitMessage(),
    createRelease: (input: Parameters<InMemoryReleaseRepository['create']>[0]) => repo.create(input),
  }
  await createReleaseSnapshotForCompletedBuild(makeRun({ runId: 2008 }), 'CMS', 'tester', options)
  assert.equal(requestedTag, 'latest')
})

// ---- createReleaseSnapshotWithRetry ----

test('retry helper resolves once the digest appears on a later attempt, using an injected sleep (no real timer wait)', async () => {
  const repo = new InMemoryReleaseRepository()
  let callCount = 0
  const sleeps: number[] = []
  const options = {
    fetchDockerHubTagDigest: async (repository: string, tag: string): Promise<DockerHubTagInfo | null> => {
      callCount += 1
      if (callCount < 3) return null // simulate Docker Hub indexing lag for the first 2 attempts
      return { repoDigest: `${repository}@sha256:${'1'.repeat(64)}`, tag }
    },
    getBuildIntent: stubNoBuildIntent(),
    getCommitMessage: stubNoCommitMessage(),
    createRelease: (input: Parameters<InMemoryReleaseRepository['create']>[0]) => repo.create(input),
    sleep: async (ms: number) => {
      sleeps.push(ms)
    },
  }
  const outcome = await createReleaseSnapshotWithRetry(makeRun({ runId: 4001 }), 'CMS', 'tester', options)
  assert.equal(outcome.outcome, 'created')
  assert.equal(callCount, 3)
  assert.deepEqual(sleeps, [2000, 4000])
})

test('retry helper gives up after exhausting all delays and returns the last digest_not_found outcome', async () => {
  const sleeps: number[] = []
  const options = {
    fetchDockerHubTagDigest: stubNoDockerHubDigest(),
    getBuildIntent: stubNoBuildIntent(),
    createRelease: async (): Promise<never> => {
      throw new Error('should never be called — digest never resolves')
    },
    delaysMs: [10, 10],
    sleep: async (ms: number) => {
      sleeps.push(ms)
    },
  }
  const outcome = await createReleaseSnapshotWithRetry(makeRun({ runId: 4002 }), 'CMS', 'tester', options)
  assert.deepEqual(outcome, { outcome: 'digest_not_found' })
  assert.deepEqual(sleeps, [10, 10])
})

test('retry helper does NOT retry a not_eligible outcome (failed build)', async () => {
  const sleeps: number[] = []
  const options = {
    fetchDockerHubTagDigest: stubNoDockerHubDigest(),
    getBuildIntent: stubNoBuildIntent(),
    sleep: async (ms: number) => {
      sleeps.push(ms)
    },
  }
  const outcome = await createReleaseSnapshotWithRetry(makeRun({ status: 'completed', conclusion: 'failure' }), 'CMS', 'tester', options)
  assert.deepEqual(outcome, { outcome: 'not_eligible' })
  assert.deepEqual(sleeps, [])
})
