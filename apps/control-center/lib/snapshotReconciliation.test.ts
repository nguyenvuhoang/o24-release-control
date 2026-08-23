import assert from 'node:assert/strict'
import test from 'node:test'
import { attemptSnapshotAndPersistPending, computeNextRetryDelayMs, isJobExpired, MAX_RECONCILE_AGE_MS } from './snapshotReconciliation'
import type { PendingSnapshotJob, SnapshotJobStore, UpsertPendingInput } from './snapshotJobStore'
import type { BuildRunSnapshot } from './types'
import type { SnapshotOutcome } from './releaseSnapshotFromBuild'

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

// ---- computeNextRetryDelayMs / isJobExpired ----

test('computeNextRetryDelayMs doubles each attempt starting at 30s, capped at 30 minutes', () => {
  assert.equal(computeNextRetryDelayMs(0), 30_000)
  assert.equal(computeNextRetryDelayMs(1), 60_000)
  assert.equal(computeNextRetryDelayMs(2), 120_000)
  assert.equal(computeNextRetryDelayMs(3), 240_000)
  assert.equal(computeNextRetryDelayMs(10), 30 * 60_000) // would be 30s*1024 uncapped — must be capped
})

test('isJobExpired is false just under the max age and true once past it', () => {
  const createdAt = new Date(0).toISOString()
  assert.equal(isJobExpired(createdAt, MAX_RECONCILE_AGE_MS - 1), false)
  assert.equal(isJobExpired(createdAt, MAX_RECONCILE_AGE_MS), true)
})

// ---- attemptSnapshotAndPersistPending ----

class FakeJobStore implements SnapshotJobStore {
  upserted: UpsertPendingInput[] = []
  completed: { service: string; runId: number; releaseId: string }[] = []

  async upsertPending(input: UpsertPendingInput): Promise<PendingSnapshotJob> {
    this.upserted.push(input)
    return {
      id: `${input.service}:${input.runId}`,
      ...input,
      status: 'pending',
      attemptCount: 0,
      nextRetryAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }
  async getJob(): Promise<PendingSnapshotJob | undefined> {
    return undefined
  }
  async markResolving(): Promise<void> {}
  async markCompletedIfExists(service: never, runId: number, releaseId: string): Promise<void> {
    this.completed.push({ service, runId, releaseId })
  }
  async markRetry(): Promise<void> {}
  async markFailedTerminal(): Promise<void> {}
  async listDuePending(): Promise<PendingSnapshotJob[]> {
    return []
  }
}

test('on digest_not_found, persists a pending job via the injected store', async () => {
  const jobStore = new FakeJobStore()
  const outcome = await attemptSnapshotAndPersistPending(makeRun({ runId: 2001 }), 'CMS', 'github-webhook', {
    snapshotJobStore: jobStore,
    createSnapshot: async (): Promise<SnapshotOutcome> => ({ outcome: 'digest_not_found' }),
  })
  assert.equal(outcome.outcome, 'digest_not_found')
  assert.equal(jobStore.upserted.length, 1)
  assert.equal(jobStore.upserted[0].runId, 2001)
  assert.equal(jobStore.upserted[0].service, 'CMS')
})

test('on created, marks any existing job completed (no-op if none existed)', async () => {
  const jobStore = new FakeJobStore()
  const outcome = await attemptSnapshotAndPersistPending(makeRun({ runId: 2002 }), 'CMS', 'poll-route', {
    snapshotJobStore: jobStore,
    createSnapshot: async (): Promise<SnapshotOutcome> => ({
      outcome: 'created',
      result: { deduped: false, record: { id: 'release:CMS:2002:1' } as never },
    }),
  })
  assert.equal(outcome.outcome, 'created')
  assert.equal(jobStore.completed.length, 1)
  assert.equal(jobStore.completed[0].releaseId, 'release:CMS:2002:1')
})

test('on not_eligible or conflict, does not touch the job store at all', async () => {
  const jobStore = new FakeJobStore()
  await attemptSnapshotAndPersistPending(makeRun({ runId: 2003 }), 'CMS', 'poll-route', {
    snapshotJobStore: jobStore,
    createSnapshot: async (): Promise<SnapshotOutcome> => ({ outcome: 'not_eligible' }),
  })
  await attemptSnapshotAndPersistPending(makeRun({ runId: 2004 }), 'CMS', 'poll-route', {
    snapshotJobStore: jobStore,
    createSnapshot: async (): Promise<SnapshotOutcome> => ({ outcome: 'conflict', releaseId: 'release:CMS:2004:1' }),
  })
  assert.equal(jobStore.upserted.length, 0)
  assert.equal(jobStore.completed.length, 0)
})

test('with no Redis configured (snapshotJobStore: null), still returns the outcome without throwing', async () => {
  const outcome = await attemptSnapshotAndPersistPending(makeRun({ runId: 2005 }), 'CMS', 'poll-route', {
    snapshotJobStore: null,
    createSnapshot: async (): Promise<SnapshotOutcome> => ({ outcome: 'digest_not_found' }),
  })
  assert.equal(outcome.outcome, 'digest_not_found')
})
