import { getAuditRepository, type AppendResult } from './auditRepository'
import type { AuditRecord } from './types'

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

export async function readAudit(limit = 50): Promise<AuditRecord[]> {
  return getAuditRepository().list(limit)
}
