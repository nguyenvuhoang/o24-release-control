import { promises as fs } from 'node:fs'
import path from 'node:path'
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
// No extra npm dependency: Vercel KV and Upstash Redis both speak the same
// single-command REST API (POST {url} with a JSON command array, Bearer
// token auth), so a plain fetch is enough.

type KvConfig = { url: string; token: string }

function resolveKvConfig(): KvConfig | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null
  return { url, token }
}

async function kvCommand(config: KvConfig, command: (string | number)[]): Promise<unknown> {
  const response = await fetch(config.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    cache: 'no-store',
  })
  const body = (await response.json().catch(() => null)) as { result?: unknown; error?: string } | null
  if (!response.ok) {
    throw new Error(`KV command failed (${response.status}): ${body?.error ?? response.statusText}`)
  }
  return body?.result
}

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

// ---- Last-resort fallback (Vercel, no KV configured yet) ----
// Explicitly in-memory rather than writing into /tmp: /tmp on Vercel is
// per-instance and just as non-durable as memory, and writing to it would
// falsely look like real persistence. This exists so the app still functions
// (with a loud warning) until KV_REST_API_URL/TOKEN is configured.

export class InMemoryAuditRepository implements AuditRepository {
  private records: AuditRecord[] = []
  private ids = new Set<string>()
  private warned = false

  async append(record: AuditRecord): Promise<AppendResult> {
    this.warnOnce()
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
    this.warnOnce()
    return this.records.slice(0, Math.min(Math.max(limit, 1), 500))
  }

  private warnOnce(): void {
    if (this.warned) return
    this.warned = true
    console.warn(
      '[audit] No persistent audit store is configured on Vercel (KV_REST_API_URL/KV_REST_API_TOKEN are unset). ' +
        'Audit records are kept in-memory only and will be lost on cold start or redeploy. ' +
        'Configure Vercel KV (or any Upstash-compatible REST endpoint) for durable audit history.',
    )
  }
}

// ---- Repository selection ----

let cachedRepository: AuditRepository | null = null

/**
 * Picks the right backend for the current deployment:
 *  - KV configured (works anywhere, incl. local dev if set) -> KvAuditRepository.
 *  - Running on Vercel without KV configured -> InMemoryAuditRepository, with
 *    a warning, so we never silently rely on Vercel's ephemeral /tmp.
 *  - Otherwise (local dev / self-hosted Docker, where CONTROL_DATA_DIR is a
 *    real persistent volume) -> FileAuditRepository.
 */
export function getAuditRepository(): AuditRepository {
  if (cachedRepository) return cachedRepository

  const kvConfig = resolveKvConfig()
  if (kvConfig) {
    cachedRepository = new KvAuditRepository(kvConfig)
  } else if (process.env.VERCEL) {
    cachedRepository = new InMemoryAuditRepository()
  } else {
    cachedRepository = new FileAuditRepository(getAuditFilePath())
  }
  return cachedRepository
}

function getAuditFilePath(): string {
  const dataDir = process.env.CONTROL_DATA_DIR ?? '/data'
  return path.join(dataDir, 'audit.jsonl')
}

/** Test-only: forces the next getAuditRepository() call to re-resolve the backend. */
export function resetAuditRepositoryForTests(): void {
  cachedRepository = null
}
