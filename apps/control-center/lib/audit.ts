import { getAuditRepository, type AppendResult } from './auditRepository'
import type { AuditRecord, BuildRunSnapshot } from './types'

/**
 * Appends an audit record only once per idempotencyKey — pass a deterministic
 * key derived from the thing being audited (e.g. `operation:${operationId}`,
 * `build:${runId}`), NOT a random value. The repository uses it as the
 * record's id and treats append as an upsert-if-absent, so an SSE reconnect
 * or a repeated settleOperation()/poll call can call this as many times as
 * it wants without producing duplicate rows — including across separate
 * process instances (KV-backed repository) or after a process restart
 * (file-backed repository).
 */
export async function appendAudit(
  input: Omit<AuditRecord, 'id' | 'timestamp'> & { idempotencyKey: string },
): Promise<AppendResult> {
  const { idempotencyKey, ...fields } = input
  const record: AuditRecord = {
    id: idempotencyKey,
    timestamp: new Date().toISOString(),
    ...fields,
  }
  return getAuditRepository().append(record)
}

/**
 * A GitHub "Re-run failed jobs" keeps the same runId but bumps run_attempt —
 * that retry deserves its own audit row (e.g. attempt 1 failed, attempt 2
 * succeeded), so the attempt is part of the key. Shared by every code path
 * that can observe a build's terminal state (the per-run poll route and the
 * latest-build discovery route) so they can never disagree on the key and
 * therefore never produce duplicate rows for the same attempt.
 */
export function buildAuditIdempotencyKey(runId: number, runAttempt: number | undefined): string {
  return `build:${runId}:attempt:${runAttempt ?? 1}`
}

/**
 * Records a build's terminal outcome. A no-op unless the run has actually
 * completed — callers can pass any run snapshot unconditionally.
 */
export async function appendBuildAudit(
  run: BuildRunSnapshot,
  service: string | undefined,
  username: string,
): Promise<AppendResult | undefined> {
  if (run.status !== 'completed') return undefined
  return appendAudit({
    idempotencyKey: buildAuditIdempotencyKey(run.runId, run.runAttempt),
    username,
    action: 'build',
    service,
    status: run.conclusion === 'success' ? 'succeeded' : 'failed',
    error: run.conclusion && run.conclusion !== 'success' ? `Build conclusion: ${run.conclusion}` : undefined,
    details: { runId: run.runId, runAttempt: run.runAttempt, branch: run.branch, commitSha: run.commitSha, htmlUrl: run.htmlUrl },
  })
}
