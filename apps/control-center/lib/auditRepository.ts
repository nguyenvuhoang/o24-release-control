import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isRunningOnVercel, kvCommand, resolveKvConfig, type KvConfig } from './kv'
import type { AuditRecord } from './types'

export type AppendResult = { record: AuditRecord; deduped: boolean }

/**
 * Storage-agnostic audit log. `append` must be idempotent on `record.id` —
 * callers pass a deterministic id (see appendAudit's idempotencyKey in
 * ./audit.ts) so an SSE reconnect or a repeated settleOperation() call never
 * produces a duplicate row, regardless of which backend is behind this
 * interface or how many process instances are handling requests.
 */
export interface AuditRepository {
  append(record: AuditRecord): Promise<AppendResult>
  list(limit: number): Promise<AuditRecord[]>
}

const MAX_RETAINED = 1000

// ---- Local / self-hosted (Docker) — a real persistent volume, not /tmp ----

export class FileAuditRepository implements AuditRepository {
  constructor(private readonly filePath: string) {}

  async append(record: AuditRecord): Promise<AppendResult> {
    const existing = await this.findById(record.id)
    if (existing) return { record: existing, deduped: true }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.appendFile(this.filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o640 })
    return { record, deduped: false }
  }

  async list(limit: number): Promise<AuditRecord[]> {
    const lines = await this.readLines()
    return lines
      .slice(-Math.min(Math.max(limit, 1), 500))
      .reverse()
      .map((line) => JSON.parse(line) as AuditRecord)
  }

  private async findById(id: string): Promise<AuditRecord | undefined> {
    const lines = await this.readLines()
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const parsed = JSON.parse(lines[i]) as AuditRecord
      if (parsed.id === id) return parsed
    }
    return undefined
  }

  private async readLines(): Promise<string[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      return raw.split('\n').filter(Boolean)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
}

// ---- Production (Vercel) — KV over the Upstash-compatible REST protocol ----

const KV_RECORD_PREFIX = 'o24:audit:record:'
const KV_INDEX_KEY = 'o24:audit:index'

export class KvAuditRepository implements AuditRepository {
  constructor(private readonly config: KvConfig) {}

  async append(record: AuditRecord): Promise<AppendResult> {
    const key = KV_RECORD_PREFIX + record.id
    // SET ... NX is the atomic idempotency check: only the first writer for
    // a given id gets "OK" back, so concurrent serverless instances racing
    // on the same operationId/build id can never both index the record.
    const setResult = await kvCommand(this.config, ['SET', key, JSON.stringify(record), 'NX'])
    if (setResult !== 'OK') {
      const existingRaw = await kvCommand(this.config, ['GET', key])
      const existing = typeof existingRaw === 'string' ? (JSON.parse(existingRaw) as AuditRecord) : record
      return { record: existing, deduped: true }
    }
    await kvCommand(this.config, ['LPUSH', KV_INDEX_KEY, record.id])
    await kvCommand(this.config, ['LTRIM', KV_INDEX_KEY, 0, MAX_RETAINED - 1])
    return { record, deduped: false }
  }

  async list(limit: number): Promise<AuditRecord[]> {
    const capped = Math.min(Math.max(limit, 1), 500)
    const ids = (await kvCommand(this.config, ['LRANGE', KV_INDEX_KEY, 0, capped - 1])) as string[] | null
    if (!ids || ids.length === 0) return []
    const raw = (await kvCommand(this.config, ['MGET', ...ids.map((id) => KV_RECORD_PREFIX + id)])) as
      | (string | null)[]
      | null
    if (!raw) return []
    return raw.filter((item): item is string => typeof item === 'string').map((item) => JSON.parse(item) as AuditRecord)
  }
}

// ---- In-memory (used only when NOT on Vercel and KV isn't configured — see
// getAuditRepositoryStatus. On Vercel without KV, /api/audit refuses to
// silently serve an empty list instead of falling back to this.) ----

export class InMemoryAuditRepository implements AuditRepository {
  private records: AuditRecord[] = []
  private ids = new Set<string>()

  async append(record: AuditRecord): Promise<AppendResult> {
    if (this.ids.has(record.id)) {
      return { record: this.records.find((item) => item.id === record.id) ?? record, deduped: true }
    }
    this.ids.add(record.id)
    this.records.unshift(record)
    if (this.records.length > MAX_RETAINED) {
      const removed = this.records.pop()
      if (removed) this.ids.delete(removed.id)
    }
    return { record, deduped: false }
  }

  async list(limit: number): Promise<AuditRecord[]> {
    return this.records.slice(0, Math.min(Math.max(limit, 1), 500))
  }
}

// ---- Repository selection ----

export type AuditBackend = 'kv' | 'file' | 'memory'

export type AuditRepositoryStatus = {
  repository: AuditRepository
  /**
   * false only in the one case that must never be silently OK: running on
   * Vercel with no KV configured. Vercel's filesystem (including /tmp) is
   * per-instance and wiped on cold start/redeploy, so this in-memory
   * fallback exists purely so the app doesn't crash — it is NOT durable
   * audit storage, and callers (see /api/audit) must surface that instead
   * of quietly returning an empty history as if nothing had ever happened.
   */
  configured: boolean
  backend: AuditBackend
}

let cachedStatus: AuditRepositoryStatus | null = null

/**
 * Picks the right backend for the current deployment:
 *  - KV configured (works anywhere, incl. local dev if set) -> KvAuditRepository, configured.
 *  - Running on Vercel without KV configured -> InMemoryAuditRepository, NOT configured.
 *  - Otherwise (local dev / self-hosted Docker, where CONTROL_DATA_DIR is a
 *    real persistent volume) -> FileAuditRepository, configured.
 */
export function getAuditRepositoryStatus(): AuditRepositoryStatus {
  if (cachedStatus) return cachedStatus

  const kvConfig = resolveKvConfig()
  if (kvConfig) {
    cachedStatus = { repository: new KvAuditRepository(kvConfig), configured: true, backend: 'kv' }
  } else if (isRunningOnVercel()) {
    cachedStatus = { repository: new InMemoryAuditRepository(), configured: false, backend: 'memory' }
  } else {
    cachedStatus = { repository: new FileAuditRepository(getAuditFilePath()), configured: true, backend: 'file' }
  }
  return cachedStatus
}

export function getAuditRepository(): AuditRepository {
  return getAuditRepositoryStatus().repository
}

function getAuditFilePath(): string {
  const dataDir = process.env.CONTROL_DATA_DIR ?? '/data'
  return path.join(dataDir, 'audit.jsonl')
}

/** Test-only: forces the next getAuditRepositoryStatus() call to re-resolve the backend. */
export function resetAuditRepositoryForTests(): void {
  cachedStatus = null
}
