import { fetchImageRevisionLabel } from './dockerHub'
import { getCommitMessage, getWorkflowRun } from './github/client'
import type { BuildServiceCode } from './github/serviceMap'
import { getReleaseRepository, isValidGitSha, type ReleaseMetadataPatch } from './releaseRepository'
import type { ReleaseSnapshot } from './types'

/**
 * Metadata enrichment for a release ALREADY on file — never creates a
 * release, never changes repoDigest/tag/source/branch/githubRunId/
 * githubRunAttempt/createdAt/artifact identity. Only fills commitSha/
 * commitMessage, and only the ones currently missing (see
 * releaseRepository.ts's mergeMetadataPatch, which enforces "never
 * overwrite" at the storage layer too — this function's own missing-field
 * checks are the fast path that avoids pointless GitHub/Docker Hub calls,
 * not the source of truth for that guarantee).
 */
export type BackfillOutcome =
  | { outcome: 'skipped_complete'; record: ReleaseSnapshot }
  | { outcome: 'skipped_not_found' }
  | { outcome: 'updated'; record: ReleaseSnapshot; filled: Array<'commitSha' | 'commitMessage'> }
  | { outcome: 'unresolved'; record: ReleaseSnapshot }

type BackfillOptions = {
  getWorkflowRun?: (runId: number) => Promise<{ commitSha: string }>
  getCommitMessage?: (sha: string) => Promise<string | null>
  fetchImageRevisionLabel?: (repository: string, repoDigest: string) => Promise<string | null>
  updateMetadata?: (id: string, patch: ReleaseMetadataPatch) => Promise<ReleaseSnapshot | undefined>
}

function logLookupFailure(step: string, releaseId: string, error: unknown) {
  console.error(`[releaseMetadataBackfill] ${step} failed`, { releaseId, error: error instanceof Error ? error.message : 'Unknown error' })
}

/**
 * Resolves and persists whatever metadata is missing on ONE release. Every
 * lookup is best-effort: a failure just leaves that field unresolved for
 * this run — re-running the backfill later is always safe (idempotent) and
 * will try again for whatever is still missing.
 */
export async function backfillReleaseMetadata(release: ReleaseSnapshot, options: BackfillOptions = {}): Promise<BackfillOutcome> {
  const missingCommitSha = !release.commitSha
  const missingCommitMessage = !release.commitMessage
  if (!missingCommitSha && !missingCommitMessage) {
    return { outcome: 'skipped_complete', record: release }
  }

  const lookupWorkflowRun = options.getWorkflowRun ?? getWorkflowRun
  const lookupCommitMessage = options.getCommitMessage ?? getCommitMessage
  const lookupRevisionLabel = options.fetchImageRevisionLabel ?? fetchImageRevisionLabel
  const updateMetadata = options.updateMetadata ?? ((id: string, patch: ReleaseMetadataPatch) => getReleaseRepository().updateMetadata(id, patch))

  // Prefer whatever commitSha is already stored — resolving it a second time
  // would be pointless. Only look one up when it's genuinely missing.
  let resolvedCommitSha = release.commitSha
  if (missingCommitSha) {
    if (release.source === 'github-actions' && release.githubRunId != null && release.githubRunAttempt != null) {
      try {
        const run = await lookupWorkflowRun(release.githubRunId)
        if (run.commitSha && isValidGitSha(run.commitSha)) resolvedCommitSha = run.commitSha.toLowerCase()
      } catch (error) {
        logLookupFailure('workflow run lookup', release.id, error)
      }
    } else if (release.source === 'docker-registry') {
      try {
        const label = await lookupRevisionLabel(release.dockerRepository, release.repoDigest)
        if (label && isValidGitSha(label)) resolvedCommitSha = label.toLowerCase()
      } catch (error) {
        logLookupFailure('OCI revision label lookup', release.id, error)
      }
    }
  }

  let resolvedCommitMessage = release.commitMessage ?? null
  if (missingCommitMessage && resolvedCommitSha) {
    try {
      resolvedCommitMessage = await lookupCommitMessage(resolvedCommitSha)
    } catch (error) {
      logLookupFailure('commit message lookup', release.id, error)
    }
  }

  const patch: ReleaseMetadataPatch = {}
  if (missingCommitSha && resolvedCommitSha) patch.commitSha = resolvedCommitSha
  if (missingCommitMessage && resolvedCommitMessage) patch.commitMessage = resolvedCommitMessage

  if (Object.keys(patch).length === 0) {
    return { outcome: 'unresolved', record: release }
  }

  const updated = await updateMetadata(release.id, patch)
  if (!updated) return { outcome: 'skipped_not_found' }

  const filled: Array<'commitSha' | 'commitMessage'> = []
  if (patch.commitSha) filled.push('commitSha')
  if (patch.commitMessage) filled.push('commitMessage')
  return { outcome: 'updated', record: updated, filled }
}

export type BackfillSummary = {
  scanned: number
  updated: number
  skippedComplete: number
  unresolved: number
  items: Array<{ id: string; service: BuildServiceCode; outcome: 'updated' | 'unresolved'; filled?: Array<'commitSha' | 'commitMessage'> }>
}

type BackfillAllOptions = BackfillOptions & {
  service?: BuildServiceCode
  /** Max releases to process in this call — bounded so one invocation stays fast under a serverless function timeout; re-invoke (idempotent) to work through more. */
  limit?: number
  /** Bounded parallelism to stay polite to GitHub/Docker Hub rate limits. */
  concurrency?: number
  listReleases?: (query: { service?: BuildServiceCode; cursor?: string; limit?: number }) => Promise<{ items: ReleaseSnapshot[]; nextCursor?: string }>
}

/**
 * Scans stored releases (newest first, same order as the Version Timeline)
 * for ones missing commitSha and/or commitMessage, and backfills as many as
 * `limit` allows. Never creates or deletes a release — see
 * backfillReleaseMetadata's own guarantees, which this just applies in bulk.
 */
export async function backfillAllReleaseMetadata(options: BackfillAllOptions = {}): Promise<BackfillSummary> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100)
  const concurrency = Math.min(Math.max(options.concurrency ?? 3, 1), 5)
  const listReleases = options.listReleases ?? ((query) => getReleaseRepository().list(query))

  const candidates: ReleaseSnapshot[] = []
  let cursor: string | undefined
  do {
    const page = await listReleases({ service: options.service, cursor, limit: 100 })
    for (const release of page.items) {
      if (candidates.length >= limit) break
      if (!release.commitSha || !release.commitMessage) candidates.push(release)
    }
    cursor = page.nextCursor
  } while (cursor && candidates.length < limit)

  const summary: BackfillSummary = { scanned: candidates.length, updated: 0, skippedComplete: 0, unresolved: 0, items: [] }

  let cursorIndex = 0
  async function worker() {
    for (;;) {
      const currentIndex = cursorIndex
      cursorIndex += 1
      if (currentIndex >= candidates.length) return
      const release = candidates[currentIndex]
      const outcome = await backfillReleaseMetadata(release, options)
      if (outcome.outcome === 'updated') {
        summary.updated += 1
        summary.items.push({ id: release.id, service: release.service, outcome: 'updated', filled: outcome.filled })
      } else if (outcome.outcome === 'skipped_complete') {
        summary.skippedComplete += 1
      } else if (outcome.outcome === 'unresolved') {
        summary.unresolved += 1
        summary.items.push({ id: release.id, service: release.service, outcome: 'unresolved' })
      }
      // 'skipped_not_found' is a race with something else deleting/moving
      // the record mid-scan — not expected (releases are never deleted),
      // but harmless to just not count if it somehow happens.
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return summary
}
