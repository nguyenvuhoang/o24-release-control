import { timingSafeEqual } from 'node:crypto'
import { computeNextRetryDelayMs, isJobExpired, MAX_RECONCILE_ATTEMPTS } from './snapshotReconciliation'
import { createReleaseSnapshotForCompletedBuild } from './releaseSnapshotFromBuild'
import { getSnapshotJobStore, type SnapshotJobStore } from './snapshotJobStore'
import type { BuildRunSnapshot } from './types'

// Pure(ish) handler for the reconciliation cron — deliberately does NOT
// import 'next/server', same split (and same reason) as
// lib/github/webhookHandler.ts: certain Next imports only resolve inside a
// Next.js/webpack build, so the logic worth testing lives here and
// app/api/cron/reconcile-snapshots/route.ts is a thin wrapper.

export type CronHandlerResult = { status: number; body: Record<string, unknown> }

export type CronHandlerDeps = {
  snapshotJobStore?: SnapshotJobStore | null
  createSnapshot?: typeof createReleaseSnapshotForCompletedBuild
  now?: () => number
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

const DUE_JOBS_PER_RUN = 50

export async function handleReconcileSnapshotsCron(authorizationHeader: string | null, deps: CronHandlerDeps = {}): Promise<CronHandlerResult> {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error('[cron/reconcile-snapshots] CRON_SECRET is not configured — refusing to run')
    return { status: 500, body: { error: 'cron_not_configured' } }
  }
  if (!authorizationHeader || !timingSafeStringEqual(authorizationHeader, `Bearer ${secret}`)) {
    return { status: 401, body: { error: 'unauthorized' } }
  }

  const jobStore = deps.snapshotJobStore !== undefined ? deps.snapshotJobStore : getSnapshotJobStore()
  if (!jobStore) {
    return { status: 200, body: { status: 'skipped', reason: 'redis_not_configured' } }
  }
  const createSnapshot = deps.createSnapshot ?? createReleaseSnapshotForCompletedBuild
  const nowMs = (deps.now ?? Date.now)()

  const dueJobs = await jobStore.listDuePending(nowMs, DUE_JOBS_PER_RUN)
  const summary = { processed: 0, completed: 0, retried: 0, failed: 0 }

  for (const job of dueJobs) {
    summary.processed += 1
    await jobStore.markResolving(job.service, job.runId)

    if (isJobExpired(job.createdAt, nowMs)) {
      await jobStore.markFailedTerminal(job.service, job.runId, 'exceeded max reconcile age')
      summary.failed += 1
      continue
    }

    const runSnapshot: BuildRunSnapshot = {
      runId: job.runId,
      status: 'completed',
      conclusion: 'success',
      htmlUrl: job.htmlUrl,
      branch: job.branch,
      commitSha: job.commitSha,
      createdAt: job.createdAt,
      updatedAt: new Date(nowMs).toISOString(),
      runAttempt: job.runAttempt,
    }

    const outcome = await createSnapshot(runSnapshot, job.service, job.createdBySource)

    if (outcome.outcome === 'created') {
      await jobStore.markCompletedIfExists(job.service, job.runId, outcome.result.record.id)
      summary.completed += 1
      continue
    }

    if (outcome.outcome === 'digest_not_found') {
      if (job.attemptCount + 1 >= MAX_RECONCILE_ATTEMPTS) {
        await jobStore.markFailedTerminal(job.service, job.runId, 'exceeded max reconcile attempts')
        summary.failed += 1
      } else {
        const nextRetryAt = new Date(nowMs + computeNextRetryDelayMs(job.attemptCount)).toISOString()
        await jobStore.markRetry(job.service, job.runId, 'digest_not_found', nextRetryAt)
        summary.retried += 1
      }
      continue
    }

    // 'not_eligible' (shouldn't happen — the run was known completed+success
    // when the job was created, and that never changes) or 'conflict' —
    // retrying can never change either outcome.
    const errorDetail = outcome.outcome === 'conflict' ? `conflict: ${outcome.releaseId}` : outcome.outcome
    await jobStore.markFailedTerminal(job.service, job.runId, errorDetail)
    summary.failed += 1
  }

  return { status: 200, body: { status: 'ok', ...summary } }
}
