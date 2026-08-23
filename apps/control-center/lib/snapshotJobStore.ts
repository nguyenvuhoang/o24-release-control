import { kvCommand, resolveKvConfig } from './kv'
import type { BuildServiceCode } from './github/serviceMap'

// Durable record of "a completed, successful build whose Release Snapshot
// couldn't be created yet because Docker Hub hadn't indexed the digest" —
// survives past the webhook's own in-request retry window (see
// lib/snapshotReconciliation.ts) so the cron endpoint
// (app/api/cron/reconcile-snapshots/route.ts) can keep trying without any
// browser or webhook redelivery involved. Redis-only, same rationale as
// lib/userRepository.ts: there is no legitimate scenario for this to exist
// without Redis, so a silent fallback would just hide a misconfiguration —
// callers must treat `getSnapshotJobStore() === null` as "no durable
// reconciliation available right now" and log loudly, never crash.

export type SnapshotJobStatus = 'pending' | 'resolving' | 'completed' | 'failed'

export type PendingSnapshotJob = {
  id: string
  service: BuildServiceCode
  runId: number
  runAttempt: number
  branch: string
  commitSha: string
  htmlUrl: string
  /** Where this job was first observed from — 'github-webhook' or a poll route identifier. Informational only. */
  createdBySource: string
  status: SnapshotJobStatus
  attemptCount: number
  lastError?: string
  nextRetryAt: string
  createdAt: string
  updatedAt: string
  /** Set only once status becomes 'completed'. */
  releaseId?: string
}

export type UpsertPendingInput = {
  service: BuildServiceCode
  runId: number
  runAttempt: number
  branch: string
  commitSha: string
  htmlUrl: string
  createdBySource: string
}

export interface SnapshotJobStore {
  /**
   * Creates a job if none exists for this service+runId, or if the existing
   * one is for a DIFFERENT runAttempt (a re-run — treated as a fresh job,
   * backoff state reset). A duplicate call for the SAME runAttempt (e.g. a
   * repeated webhook delivery) returns the existing job UNCHANGED — it must
   * never reset in-progress backoff/attempt state.
   */
  upsertPending(input: UpsertPendingInput): Promise<PendingSnapshotJob>
  getJob(service: BuildServiceCode, runId: number): Promise<PendingSnapshotJob | undefined>
  markResolving(service: BuildServiceCode, runId: number): Promise<void>
  /** No-op if no job exists for this service+runId (e.g. the snapshot was created on the very first attempt, no job was ever persisted). */
  markCompletedIfExists(service: BuildServiceCode, runId: number, releaseId: string): Promise<void>
  markRetry(service: BuildServiceCode, runId: number, error: string, nextRetryAt: string): Promise<void>
  markFailedTerminal(service: BuildServiceCode, runId: number, error: string): Promise<void>
  /** Jobs with status 'pending' and nextRetryAt <= nowMs, oldest-due first. */
  listDuePending(nowMs: number, limit: number): Promise<PendingSnapshotJob[]>
}

function jobId(service: BuildServiceCode, runId: number): string {
  return `${service}:${runId}`
}

const RECORD_PREFIX = 'o24:snapshot-job:record:'
const PENDING_ZSET_KEY = 'o24:snapshot-job:pending'

function recordKey(service: BuildServiceCode, runId: number): string {
  return RECORD_PREFIX + jobId(service, runId)
}

export class KvSnapshotJobStore implements SnapshotJobStore {
  constructor(private readonly config: NonNullable<ReturnType<typeof resolveKvConfig>>) {}

  async upsertPending(input: UpsertPendingInput): Promise<PendingSnapshotJob> {
    const key = recordKey(input.service, input.runId)
    const existing = await this.getJob(input.service, input.runId)
    if (existing && existing.runAttempt === input.runAttempt) {
      return existing
    }

    const now = new Date().toISOString()
    const job: PendingSnapshotJob = {
      id: jobId(input.service, input.runId),
      service: input.service,
      runId: input.runId,
      runAttempt: input.runAttempt,
      branch: input.branch,
      commitSha: input.commitSha,
      htmlUrl: input.htmlUrl,
      createdBySource: input.createdBySource,
      status: 'pending',
      attemptCount: 0,
      nextRetryAt: now,
      createdAt: now,
      updatedAt: now,
    }
    await kvCommand(this.config, ['SET', key, JSON.stringify(job)])
    await kvCommand(this.config, ['ZADD', PENDING_ZSET_KEY, Date.parse(now), job.id])
    return job
  }

  async getJob(service: BuildServiceCode, runId: number): Promise<PendingSnapshotJob | undefined> {
    const raw = await kvCommand(this.config, ['GET', recordKey(service, runId)])
    return typeof raw === 'string' ? (JSON.parse(raw) as PendingSnapshotJob) : undefined
  }

  private async writeJob(job: PendingSnapshotJob): Promise<void> {
    await kvCommand(this.config, ['SET', recordKey(job.service, job.runId), JSON.stringify(job)])
  }

  private async removeFromPendingZset(job: PendingSnapshotJob): Promise<void> {
    await kvCommand(this.config, ['ZREM', PENDING_ZSET_KEY, job.id])
  }

  async markResolving(service: BuildServiceCode, runId: number): Promise<void> {
    const job = await this.getJob(service, runId)
    if (!job) return
    await this.writeJob({ ...job, status: 'resolving', updatedAt: new Date().toISOString() })
  }

  async markCompletedIfExists(service: BuildServiceCode, runId: number, releaseId: string): Promise<void> {
    const job = await this.getJob(service, runId)
    if (!job) return
    const updated: PendingSnapshotJob = { ...job, status: 'completed', releaseId, updatedAt: new Date().toISOString() }
    await this.writeJob(updated)
    await this.removeFromPendingZset(updated)
  }

  async markRetry(service: BuildServiceCode, runId: number, error: string, nextRetryAt: string): Promise<void> {
    const job = await this.getJob(service, runId)
    if (!job) return
    const updated: PendingSnapshotJob = {
      ...job,
      status: 'pending',
      attemptCount: job.attemptCount + 1,
      lastError: error,
      nextRetryAt,
      updatedAt: new Date().toISOString(),
    }
    await this.writeJob(updated)
    await kvCommand(this.config, ['ZADD', PENDING_ZSET_KEY, Date.parse(nextRetryAt), updated.id])
  }

  async markFailedTerminal(service: BuildServiceCode, runId: number, error: string): Promise<void> {
    const job = await this.getJob(service, runId)
    if (!job) return
    const updated: PendingSnapshotJob = { ...job, status: 'failed', lastError: error, attemptCount: job.attemptCount + 1, updatedAt: new Date().toISOString() }
    await this.writeJob(updated)
    await this.removeFromPendingZset(updated)
  }

  async listDuePending(nowMs: number, limit: number): Promise<PendingSnapshotJob[]> {
    const ids = (await kvCommand(this.config, ['ZRANGEBYSCORE', PENDING_ZSET_KEY, '-inf', nowMs, 'LIMIT', 0, limit])) as string[] | null
    if (!ids || ids.length === 0) return []
    const raw = (await kvCommand(this.config, ['MGET', ...ids.map((id) => RECORD_PREFIX + id)])) as (string | null)[] | null
    return (raw ?? [])
      .filter((item): item is string => typeof item === 'string')
      .map((item) => JSON.parse(item) as PendingSnapshotJob)
      .filter((job) => job.status === 'pending')
  }
}

/** Returns null when Redis isn't configured — callers must log and skip durable reconciliation, never crash. */
export function getSnapshotJobStore(): SnapshotJobStore | null {
  const kvConfig = resolveKvConfig()
  if (!kvConfig) return null
  return new KvSnapshotJobStore(kvConfig)
}
