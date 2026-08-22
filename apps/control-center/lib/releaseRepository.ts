import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isRunningOnVercel, kvCommand, resolveKvConfig, type KvConfig } from './kv'
import { BUILD_SERVICES, isBuildServiceCode, type BuildServiceCode } from './github/serviceMap'
import type { ReleaseDeployIntent, ReleaseSnapshot, ReleaseSource } from './types'

/**
 * Storage-agnostic Release Repository. A ReleaseSnapshot is immutable once
 * created: `create` must be idempotent on the deterministic id (see
 * buildReleaseId) — calling it again with the same data returns the
 * existing record (`deduped: true`); calling it again with different data
 * for the same id (e.g. a different repoDigest for the same run+attempt)
 * must never silently overwrite the original — it throws ReleaseConflictError.
 */
export interface ReleaseRepository {
  create(input: CreateReleaseInput): Promise<CreateReleaseResult>
  getById(id: string): Promise<ReleaseSnapshot | undefined>
  getByRun(runId: number, runAttempt: number): Promise<ReleaseSnapshot | undefined>
  /** repoDigest may be the full "repo@sha256:<hex>" reference or the bare "sha256:<hex>" — only the hex is used to match. */
  getByDigest(service: BuildServiceCode, repoDigest: string): Promise<ReleaseSnapshot | undefined>
  list(query?: ListReleasesQuery): Promise<ReleaseListResult>
}

export type CreateReleaseInput = {
  service: string
  /** Defaults to 'github-actions' — the only source that existed before Docker Hub sync. */
  source?: ReleaseSource
  // Required (and validated) for source 'github-actions'; optional/nullable
  // for 'docker-registry', where none of these are knowable from a registry
  // scan alone.
  branch?: string | null
  commitSha?: string | null
  commitMessage?: string | null
  githubRunId?: number | null
  githubRunAttempt?: number | null
  dockerRepository: string
  repoDigest: string
  tag: string
  createdBy: string
  discoveredAt?: string
}

export type CreateReleaseResult = { record: ReleaseSnapshot; deduped: boolean }

export type ListReleasesQuery = {
  service?: BuildServiceCode
  limit?: number
  cursor?: string
  // Applied AFTER the underlying sorted-by-time page is read (see
  // paginateReleases) — a returned page can have fewer than `limit` items
  // even though more matches exist further back in the index.
  branch?: string
  source?: ReleaseSource
  /** ISO 8601 — inclusive lower bound on createdAt. */
  since?: string
  /** ISO 8601 — inclusive upper bound on createdAt. */
  until?: string
}
export type ReleaseListResult = { items: ReleaseSnapshot[]; nextCursor?: string }

export class InvalidReleaseInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidReleaseInputError'
  }
}

/** A release with this id already exists with different data — never overwritten. */
export class ReleaseConflictError extends Error {
  constructor(public readonly releaseId: string) {
    super(`Release ${releaseId} already exists with different data`)
    this.name = 'ReleaseConflictError'
  }
}

// ---- Shared: id, validation, dedupe comparison (used by every backend) ----

export function buildReleaseId(service: BuildServiceCode, githubRunId: number, githubRunAttempt: number): string {
  return `release:${service}:${githubRunId}:${githubRunAttempt}`
}

// Extracts the bare 64-hex digest out of either form of a digest reference
// ("repo@sha256:<hex>" or the bare "sha256:<hex>" the Deploy Agent reports)
// so the two can always be compared/keyed on the same value. Returns null if
// no valid digest is found.
export function digestHexOf(value: string): string | null {
  const match = value.match(/sha256:([0-9a-f]{64})/i)
  return match ? match[1].toLowerCase() : null
}

export type ReleaseDeployPlan =
  | { ok: true; toRepoDigest: string }
  | { ok: false; reason: 'missing_digest' | 'already_current' }

/**
 * Pure decision logic behind POST /api/releases/[id]/deploy, factored out so
 * the "always deploy exactly the stored snapshot's digest, never anything
 * else" guarantee and the rollback no-op guard are directly unit-testable
 * without Next.js/the agent/HTTP. `toRepoDigest` is derived ONLY from
 * `release.repoDigest` — `fromRepoDigest` is consulted purely to decide
 * whether to reject, never to decide what to deploy.
 */
export function planReleaseDeploy(
  release: Pick<ReleaseSnapshot, 'repoDigest'>,
  intent: ReleaseDeployIntent,
  fromRepoDigest: string | undefined,
): ReleaseDeployPlan {
  const digestHex = digestHexOf(release.repoDigest)
  if (!digestHex) return { ok: false, reason: 'missing_digest' }
  const toRepoDigest = `sha256:${digestHex}`
  if (intent === 'rollback' && fromRepoDigest && digestHexOf(fromRepoDigest) === digestHex) {
    return { ok: false, reason: 'already_current' }
  }
  return { ok: true, toRepoDigest }
}

// docker-registry releases have no run+attempt to key off, so they're keyed
// by the digest itself instead — re-syncing the same Docker Hub digest for a
// service is therefore naturally idempotent, exactly like re-observing the
// same run+attempt is for buildReleaseId above.
export function buildRegistryReleaseId(service: BuildServiceCode, repoDigest: string): string {
  return `release:${service}:digest:${digestHexOf(repoDigest) ?? repoDigest}`
}

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i

// Docker distribution reference component grammar (simplified): lowercase
// alphanumerics separated by single dots/underscores/hyphens or a double
// underscore, path segments separated by "/". Deliberately excludes bare
// local image IDs (which have no "@sha256:" digest at all) and mutable tags.
const DIGEST_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/i

function isImmutableRepoDigest(value: string): boolean {
  const at = value.lastIndexOf('@')
  if (at <= 0 || at === value.length - 1) return false
  const repository = value.slice(0, at)
  const digest = value.slice(at + 1)
  if (!SHA256_DIGEST.test(digest)) return false
  return repository.split('/').every((segment) => DIGEST_COMPONENT.test(segment))
}

function positiveInt(value: number | null | undefined, field: string): number | null {
  if (value == null) return null
  if (!Number.isInteger(value) || value <= 0) {
    throw new InvalidReleaseInputError(`${field} must be a positive integer`)
  }
  return value
}

function prepareRelease(input: CreateReleaseInput): ReleaseSnapshot {
  const service = input.service.trim().toUpperCase()
  if (!isBuildServiceCode(service)) {
    throw new InvalidReleaseInputError(`service must be one of: ${BUILD_SERVICES.join(', ')}`)
  }
  const source: ReleaseSource = input.source ?? 'github-actions'
  if (!isImmutableRepoDigest(input.repoDigest)) {
    throw new InvalidReleaseInputError(
      'repoDigest must be an immutable registry reference (repository@sha256:<64 hex>), not a local Docker image ID or a mutable tag',
    )
  }
  const dockerRepository = input.dockerRepository.trim()
  const tag = input.tag.trim()
  const createdBy = input.createdBy.trim()
  if (!dockerRepository || !tag || !createdBy) {
    throw new InvalidReleaseInputError('dockerRepository, tag and createdBy must be non-empty')
  }
  const branch = input.branch?.trim() || null
  const commitSha = input.commitSha?.trim() || null
  const commitMessage = input.commitMessage?.trim() || null
  if (commitSha && !GIT_SHA_PATTERN.test(commitSha)) {
    throw new InvalidReleaseInputError('commitSha must be a 40-character hex Git SHA')
  }
  const githubRunId = positiveInt(input.githubRunId, 'githubRunId')
  const githubRunAttempt = positiveInt(input.githubRunAttempt, 'githubRunAttempt')

  let id: string
  if (source === 'github-actions') {
    // The one path that existed before Docker Hub sync — unchanged
    // requirements: a real build always has a branch, a commit and a run.
    if (!branch) throw new InvalidReleaseInputError('branch is required for a github-actions release')
    if (!commitSha) throw new InvalidReleaseInputError('commitSha is required for a github-actions release')
    if (githubRunId == null) throw new InvalidReleaseInputError('githubRunId is required for a github-actions release')
    if (githubRunAttempt == null) throw new InvalidReleaseInputError('githubRunAttempt is required for a github-actions release')
    id = buildReleaseId(service, githubRunId, githubRunAttempt)
  } else {
    id = buildRegistryReleaseId(service, input.repoDigest)
  }

  return {
    id,
    service,
    source,
    branch,
    commitSha,
    commitMessage,
    dockerRepository,
    repoDigest: input.repoDigest,
    tag,
    githubRunId,
    githubRunAttempt,
    createdAt: new Date().toISOString(),
    createdBy,
    discoveredAt: input.discoveredAt,
  }
}

// createdAt/discoveredAt are intentionally excluded: both are generated (or
// refreshed) fresh on every create() call, so a genuine repeat (same
// release, called again — e.g. re-syncing an already-known Docker Hub
// digest) would otherwise never compare equal to the stored original.
//
// commitMessage is compared with `?? null` on both sides: it's a field added
// after the first releases were already written to KV/File storage, so an
// old stored record has it as `undefined` (the key is simply absent from
// its JSON) while a freshly prepared one always has it as `null` — without
// normalizing, that mismatch alone would make re-syncing an already-known
// pre-existing release wrongly throw ReleaseConflictError instead of
// deduping. This is exactly the "keep backward compatibility with old data"
// requirement in practice.
function sameReleaseData(a: ReleaseSnapshot, b: ReleaseSnapshot): boolean {
  return (
    a.service === b.service &&
    a.source === b.source &&
    a.branch === b.branch &&
    a.commitSha === b.commitSha &&
    (a.commitMessage ?? null) === (b.commitMessage ?? null) &&
    a.dockerRepository === b.dockerRepository &&
    a.repoDigest === b.repoDigest &&
    a.tag === b.tag &&
    a.githubRunId === b.githubRunId &&
    a.githubRunAttempt === b.githubRunAttempt &&
    a.createdBy === b.createdBy
  )
}

function runKeyString(runId: number, runAttempt: number): string {
  return `${runId}:${runAttempt}`
}

function digestIndexKeyString(service: BuildServiceCode, digestHex: string): string {
  return `${service}:${digestHex}`
}

function matchesFilters(release: ReleaseSnapshot, query: ListReleasesQuery): boolean {
  if (query.service && release.service !== query.service) return false
  if (query.branch && release.branch !== query.branch) return false
  if (query.source && release.source !== query.source) return false
  if (query.since && release.createdAt < query.since) return false
  if (query.until && release.createdAt > query.until) return false
  return true
}

// ISO 8601 timestamps sort correctly as plain strings, so descending-by-time
// needs no Date parsing.
function paginateReleases(all: ReleaseSnapshot[], query: ListReleasesQuery): ReleaseListResult {
  const filtered = all.filter((release) => matchesFilters(release, query))
  const sorted = [...filtered].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
  const offset = query.cursor ? Math.max(Number(query.cursor) || 0, 0) : 0
  const items = sorted.slice(offset, offset + limit)
  const nextCursor = offset + limit < sorted.length ? String(offset + limit) : undefined
  return { items, nextCursor }
}

// ---- Local / self-hosted (Docker) — a real persistent volume, not /tmp ----

export class FileReleaseRepository implements ReleaseRepository {
  constructor(private readonly filePath: string) {}

  async create(input: CreateReleaseInput): Promise<CreateReleaseResult> {
    const prepared = prepareRelease(input)
    const all = await this.readAll()
    const existing = all.find((release) => release.id === prepared.id)
    if (existing) {
      if (!sameReleaseData(existing, prepared)) throw new ReleaseConflictError(prepared.id)
      return { record: existing, deduped: true }
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.appendFile(this.filePath, `${JSON.stringify(prepared)}\n`, { encoding: 'utf8', mode: 0o640 })
    return { record: prepared, deduped: false }
  }

  async getById(id: string): Promise<ReleaseSnapshot | undefined> {
    const all = await this.readAll()
    return all.find((release) => release.id === id)
  }

  async getByRun(runId: number, runAttempt: number): Promise<ReleaseSnapshot | undefined> {
    const all = await this.readAll()
    return all.find((release) => release.githubRunId === runId && release.githubRunAttempt === runAttempt)
  }

  async getByDigest(service: BuildServiceCode, repoDigest: string): Promise<ReleaseSnapshot | undefined> {
    const digestHex = digestHexOf(repoDigest)
    if (!digestHex) return undefined
    const all = await this.readAll()
    return all.find((release) => release.service === service && digestHexOf(release.repoDigest) === digestHex)
  }

  async list(query: ListReleasesQuery = {}): Promise<ReleaseListResult> {
    return paginateReleases(await this.readAll(), query)
  }

  private async readAll(): Promise<ReleaseSnapshot[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ReleaseSnapshot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
}

// ---- Production (Vercel) — KV over the Upstash-compatible REST protocol ----

const KV_RECORD_PREFIX = 'o24:release:record:'
const KV_INDEX_KEY = 'o24:release:index'
const KV_INDEX_SERVICE_PREFIX = 'o24:release:index:service:'

function kvRunKey(runId: number, runAttempt: number): string {
  return `o24:release:run:${runId}:attempt:${runAttempt}`
}

// Universal (both sources) digest -> releaseId pointer, so "which release is
// this live repoDigest" (see /api/releases/environment-state) is a single
// GET, never a scan. Two releases sharing an identical digest is a benign
// edge case (byte-identical rebuild) — last write wins, and either answer is
// equally correct since the image content is the same either way.
function kvDigestKey(service: BuildServiceCode, digestHex: string): string {
  return `o24:release:index:service:${service}:digest:${digestHex}`
}

export class KvReleaseRepository implements ReleaseRepository {
  constructor(private readonly config: KvConfig) {}

  async create(input: CreateReleaseInput): Promise<CreateReleaseResult> {
    const prepared = prepareRelease(input)
    const key = KV_RECORD_PREFIX + prepared.id
    // SET ... NX is the atomic idempotency check: only the first writer for
    // a given release id gets "OK" back, so concurrent instances observing
    // the same GitHub run+attempt can never both index the record.
    const setResult = await kvCommand(this.config, ['SET', key, JSON.stringify(prepared), 'NX'])
    if (setResult !== 'OK') {
      const existingRaw = await kvCommand(this.config, ['GET', key])
      const existing = typeof existingRaw === 'string' ? (JSON.parse(existingRaw) as ReleaseSnapshot) : prepared
      if (!sameReleaseData(existing, prepared)) throw new ReleaseConflictError(prepared.id)
      // Self-heal: a record written before an index existed (e.g. the
      // digest index added after this release was first created) would
      // otherwise stay permanently unreachable through that index. SET/ZADD
      // are idempotent, so re-writing them here on every dedupe is harmless
      // once already up to date, and eventually backfills any old record
      // that gets touched again (a build re-observed, a re-sync, etc.).
      await this.writeIndexes(existing)
      return { record: existing, deduped: true }
    }

    await this.writeIndexes(prepared)
    return { record: prepared, deduped: false }
  }

  private async writeIndexes(record: ReleaseSnapshot): Promise<void> {
    const score = Date.parse(record.createdAt)
    await kvCommand(this.config, ['ZADD', KV_INDEX_KEY, score, record.id])
    await kvCommand(this.config, ['ZADD', KV_INDEX_SERVICE_PREFIX + record.service, score, record.id])
    // Only github-actions releases have a run+attempt to index by — a
    // docker-registry release leaves both null, and indexing that would
    // collide every such release for a service under one bogus key.
    if (record.githubRunId != null && record.githubRunAttempt != null) {
      await kvCommand(this.config, ['SET', kvRunKey(record.githubRunId, record.githubRunAttempt), record.id])
    }
    const digestHex = digestHexOf(record.repoDigest)
    if (digestHex) {
      await kvCommand(this.config, ['SET', kvDigestKey(record.service, digestHex), record.id])
    }
  }

  async getById(id: string): Promise<ReleaseSnapshot | undefined> {
    const raw = await kvCommand(this.config, ['GET', KV_RECORD_PREFIX + id])
    return typeof raw === 'string' ? (JSON.parse(raw) as ReleaseSnapshot) : undefined
  }

  async getByRun(runId: number, runAttempt: number): Promise<ReleaseSnapshot | undefined> {
    const id = await kvCommand(this.config, ['GET', kvRunKey(runId, runAttempt)])
    if (typeof id !== 'string') return undefined
    return this.getById(id)
  }

  async getByDigest(service: BuildServiceCode, repoDigest: string): Promise<ReleaseSnapshot | undefined> {
    const digestHex = digestHexOf(repoDigest)
    if (!digestHex) return undefined
    const id = await kvCommand(this.config, ['GET', kvDigestKey(service, digestHex)])
    if (typeof id !== 'string') return undefined
    return this.getById(id)
  }

  async list(query: ListReleasesQuery = {}): Promise<ReleaseListResult> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
    const offset = query.cursor ? Math.max(Number(query.cursor) || 0, 0) : 0
    const key = query.service ? KV_INDEX_SERVICE_PREFIX + query.service : KV_INDEX_KEY
    // ZREVRANGE: highest score (newest createdAt) first.
    const ids = (await kvCommand(this.config, ['ZREVRANGE', key, offset, offset + limit - 1])) as string[] | null
    if (!ids || ids.length === 0) return { items: [] }
    const raw = (await kvCommand(this.config, ['MGET', ...ids.map((id) => KV_RECORD_PREFIX + id)])) as (string | null)[] | null
    const items = (raw ?? [])
      .filter((item): item is string => typeof item === 'string')
      .map((item) => JSON.parse(item) as ReleaseSnapshot)
      // branch/source/since/until aren't part of the ZSET index — applied
      // here, within this page, same tradeoff documented on ListReleasesQuery.
      .filter((release) => matchesFilters(release, query))
    const nextCursor = ids.length === limit ? String(offset + limit) : undefined
    return { items, nextCursor }
  }
}

// ---- In-memory (used only when NOT on Vercel and KV isn't configured — see
// getReleaseRepositoryStatus — and by tests) ----

export class InMemoryReleaseRepository implements ReleaseRepository {
  private records = new Map<string, ReleaseSnapshot>()
  private byRun = new Map<string, string>()
  private byDigest = new Map<string, string>()

  async create(input: CreateReleaseInput): Promise<CreateReleaseResult> {
    const prepared = prepareRelease(input)
    const existing = this.records.get(prepared.id)
    if (existing) {
      if (!sameReleaseData(existing, prepared)) throw new ReleaseConflictError(prepared.id)
      return { record: existing, deduped: true }
    }
    this.records.set(prepared.id, prepared)
    if (prepared.githubRunId != null && prepared.githubRunAttempt != null) {
      this.byRun.set(runKeyString(prepared.githubRunId, prepared.githubRunAttempt), prepared.id)
    }
    const digestHex = digestHexOf(prepared.repoDigest)
    if (digestHex) {
      this.byDigest.set(digestIndexKeyString(prepared.service, digestHex), prepared.id)
    }
    return { record: prepared, deduped: false }
  }

  async getById(id: string): Promise<ReleaseSnapshot | undefined> {
    return this.records.get(id)
  }

  async getByRun(runId: number, runAttempt: number): Promise<ReleaseSnapshot | undefined> {
    const id = this.byRun.get(runKeyString(runId, runAttempt))
    return id ? this.records.get(id) : undefined
  }

  async getByDigest(service: BuildServiceCode, repoDigest: string): Promise<ReleaseSnapshot | undefined> {
    const digestHex = digestHexOf(repoDigest)
    if (!digestHex) return undefined
    const id = this.byDigest.get(digestIndexKeyString(service, digestHex))
    return id ? this.records.get(id) : undefined
  }

  async list(query: ListReleasesQuery = {}): Promise<ReleaseListResult> {
    return paginateReleases([...this.records.values()], query)
  }
}

// ---- Repository selection ----

export type ReleaseBackend = 'kv' | 'file' | 'memory'

export type ReleaseRepositoryStatus = {
  repository: ReleaseRepository
  /** Same caveat as AuditRepositoryStatus.configured — see auditRepository.ts. */
  configured: boolean
  backend: ReleaseBackend
}

let cachedStatus: ReleaseRepositoryStatus | null = null

/**
 * Picks the right backend for the current deployment — mirrors
 * getAuditRepositoryStatus in auditRepository.ts:
 *  - KV configured (works anywhere, incl. local dev if set) -> KvReleaseRepository, configured.
 *  - Running on Vercel without KV configured -> InMemoryReleaseRepository, NOT configured.
 *  - Otherwise (local dev / self-hosted Docker, where CONTROL_DATA_DIR is a
 *    real persistent volume) -> FileReleaseRepository, configured.
 */
export function getReleaseRepositoryStatus(): ReleaseRepositoryStatus {
  if (cachedStatus) return cachedStatus

  const kvConfig = resolveKvConfig()
  if (kvConfig) {
    cachedStatus = { repository: new KvReleaseRepository(kvConfig), configured: true, backend: 'kv' }
  } else if (isRunningOnVercel()) {
    cachedStatus = { repository: new InMemoryReleaseRepository(), configured: false, backend: 'memory' }
  } else {
    cachedStatus = { repository: new FileReleaseRepository(getReleaseFilePath()), configured: true, backend: 'file' }
  }
  return cachedStatus
}

export function getReleaseRepository(): ReleaseRepository {
  return getReleaseRepositoryStatus().repository
}

function getReleaseFilePath(): string {
  const dataDir = process.env.CONTROL_DATA_DIR ?? '/data'
  return path.join(dataDir, 'releases.jsonl')
}

/** Test-only: forces the next getReleaseRepositoryStatus() call to re-resolve the backend. */
export function resetReleaseRepositoryForTests(): void {
  cachedStatus = null
}
