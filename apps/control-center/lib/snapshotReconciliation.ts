import { createReleaseSnapshotForCompletedBuild, type SnapshotOutcome } from './releaseSnapshotFromBuild'
import { getSnapshotJobStore, type SnapshotJobStore } from './snapshotJobStore'
import type { BuildRunSnapshot } from './types'
import type { BuildServiceCode } from './github/serviceMap'

// Bounds for the DURABLE (cron-driven) retry loop — deliberately generous
// compared to the webhook's own in-request retry (2s/4s/8s), since these
// retries happen across separate cron invocations over real time, not
// within one HTTP request's duration budget.
export const MAX_RECONCILE_ATTEMPTS = 10
export const MAX_RECONCILE_AGE_MS = 24 * 60 * 60 * 1000 // 24h
const BASE_BACKOFF_MS = 30_000 // 30s
const MAX_BACKOFF_MS = 30 * 60_000 // 30min cap

/** Exponential backoff, capped — pure so the schedule is directly verifiable without waiting on a real clock. */
export function computeNextRetryDelayMs(attemptCount: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attemptCount, MAX_BACKOFF_MS)
}

export function isJobExpired(createdAt: string, nowMs: number): boolean {
  return nowMs - Date.parse(createdAt) >= MAX_RECONCILE_AGE_MS
}

/**
 * Single attempt at creating a Release Snapshot, with durable pending-job
 * bookkeeping layered on top of the existing idempotent
 * createReleaseSnapshotForCompletedBuild: on 'digest_not_found' it persists
 * (or updates) a job in Redis so the cron endpoint
 * (app/api/cron/reconcile-snapshots/route.ts) can keep trying even if
 * nobody ever calls this again — the webhook's own immediate retries and
 * the poll routes both call THIS, not the raw function, specifically so
 * "ran out of immediate retries" never means "gave up".
 */
export async function attemptSnapshotAndPersistPending(
  run: BuildRunSnapshot,
  service: BuildServiceCode,
  createdBySource: string,
  options: { snapshotJobStore?: SnapshotJobStore | null; createSnapshot?: typeof createReleaseSnapshotForCompletedBuild } = {},
): Promise<SnapshotOutcome> {
  const jobStore = options.snapshotJobStore !== undefined ? options.snapshotJobStore : getSnapshotJobStore()
  const createSnapshot = options.createSnapshot ?? createReleaseSnapshotForCompletedBuild

  const outcome = await createSnapshot(run, service, createdBySource)

  if (!jobStore) {
    if (outcome.outcome === 'digest_not_found') {
      console.error('[snapshotReconciliation] digest not found and no Redis configured — this build will NOT be durably reconciled', {
        service,
        runId: run.runId,
      })
    }
    return outcome
  }

  if (outcome.outcome === 'digest_not_found') {
    await jobStore.upsertPending({
      service,
      runId: run.runId,
      runAttempt: run.runAttempt ?? 1,
      branch: run.branch,
      commitSha: run.commitSha,
      htmlUrl: run.htmlUrl,
      createdBySource,
    })
  } else if (outcome.outcome === 'created') {
    // A job may or may not exist (webhook succeeded on its first immediate
    // retry, no durable job was ever needed) — markCompletedIfExists is a
    // no-op either way.
    await jobStore.markCompletedIfExists(service, run.runId, outcome.result.record.id)
  }

  return outcome
}
