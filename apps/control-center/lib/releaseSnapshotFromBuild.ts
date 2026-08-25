import { fetchDockerHubTagDigest } from './dockerHub'
import { getBuildIntent } from './buildPointerStore'
import { getCommitMessage } from './github/client'
import { imageRepositoryFor, type BuildServiceCode } from './github/serviceMap'
import { getReleaseRepository, ReleaseConflictError, type CreateReleaseResult, type CreateReleaseInput } from './releaseRepository'
import type { BuildIntent, BuildRunSnapshot, DockerHubTagInfo } from './types'

type CreateSnapshotOptions = {
  // The four lookups below default to the real DockerHub/BuildIntent/GitHub/
  // ReleaseRepository calls — overridable purely so this function's
  // branching is unit-testable without live Docker Hub/KV/GitHub/file I/O,
  // not because any real caller needs to swap them (same convention as
  // latestReleaseResolver.ts's ResolveOptions).
  fetchDockerHubTagDigest?: (repository: string, tag: string) => Promise<DockerHubTagInfo | null>
  getBuildIntent?: (runId: number) => Promise<BuildIntent | undefined>
  getCommitMessage?: (sha: string) => Promise<string | null>
  createRelease?: (input: CreateReleaseInput) => Promise<CreateReleaseResult>
}

// Discriminated so callers can tell WHY nothing was created — the webhook
// handler (app/api/webhooks/github/route.ts) needs this to know whether a
// retry makes sense (digest_not_found — Docker Hub indexing lag, worth
// retrying) versus not (not_eligible/conflict — retrying can't change the
// outcome). The poll routes don't need to branch on this; they call this
// function fire-and-forget exactly as before.
export type SnapshotOutcome =
  | { outcome: 'created'; result: CreateReleaseResult }
  | { outcome: 'not_eligible' }
  | { outcome: 'digest_not_found' }
  | { outcome: 'conflict'; releaseId: string }

/**
 * Closes a real gap traced end-to-end during Chat 06 hardening: NOTHING in
 * this codebase previously created a `source: 'github-actions'`
 * ReleaseSnapshot when a build actually completed. `POST /api/builds` only
 * dispatches + records a BuildIntent; the two poll routes
 * (/api/builds/[runId], /api/builds/latest) only called appendBuildAudit
 * (one audit row, not a release). The only working path to a ReleaseSnapshot
 * was the manual "Đồng bộ Registry" button (source: 'docker-registry') —
 * confirmed by the dashboard's own "Build ngoài hệ thống, chưa đồng bộ"
 * state showing up for builds this app itself had just triggered.
 *
 * Called from three places, all sharing this one idempotent function:
 * the GitHub webhook (app/api/webhooks/github/route.ts, the PRIMARY,
 * browser-independent trigger), and the two poll routes (fallback/
 * reconciliation — batch build reuses those same routes per service, so
 * this needs no batch-specific code to give each service its own snapshot).
 */
export async function createReleaseSnapshotForCompletedBuild(
  run: BuildRunSnapshot,
  service: BuildServiceCode,
  createdBy: string,
  options: CreateSnapshotOptions = {},
): Promise<SnapshotOutcome> {
  // Never even attempt this for a run still in progress, or one that didn't
  // succeed — a snapshot must never exist for a failed/cancelled build.
  if (run.status !== 'completed' || run.conclusion !== 'success') return { outcome: 'not_eligible' }

  const lookupDockerHubDigest = options.fetchDockerHubTagDigest ?? fetchDockerHubTagDigest
  const lookupBuildIntent = options.getBuildIntent ?? getBuildIntent
  const lookupCommitMessage = options.getCommitMessage ?? getCommitMessage
  const createRelease = options.createRelease ?? ((input) => getReleaseRepository().create(input))

  const dockerRepository = imageRepositoryFor(service)
  // The tag this run was actually dispatched with (control-center-originated
  // builds only — see buildPointerStore.ts). A build GitHub Actions ran from
  // Telegram or a direct GitHub-UI dispatch has no BuildIntent here; 'latest'
  // matches /api/builds' own default when a caller omits `tag`.
  const intent = await lookupBuildIntent(run.runId).catch(() => undefined)
  const tag = intent?.tag ?? 'latest'

  const dockerHub = await lookupDockerHubDigest(dockerRepository, tag).catch((error) => {
    console.error('[releaseSnapshotFromBuild] Docker Hub digest lookup failed', {
      service,
      runId: run.runId,
      tag,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return null
  })
  if (!dockerHub) {
    // Best-effort: a completed, successful build with no discoverable digest
    // yet (Docker Hub indexing lag, or the push used a different tag than we
    // guessed) must not fail the caller — the webhook retries this outcome,
    // and a poll route or manual "Đồng bộ Registry" can also still pick it
    // up later.
    console.error('[releaseSnapshotFromBuild] no Docker Hub digest found (yet)', { service, runId: run.runId, dockerRepository, tag })
    return { outcome: 'digest_not_found' }
  }

  // Best-effort, never blocks the snapshot: a run always has a commitSha by
  // this point (validated by BuildRunSnapshot's source), but GitHub's commit
  // endpoint can still 404/rate-limit/permission-fail independently of the
  // run lookup that already succeeded.
  const commitMessage = await lookupCommitMessage(run.commitSha).catch((error) => {
    console.error('[releaseSnapshotFromBuild] commit message lookup failed', {
      service,
      runId: run.runId,
      commitSha: run.commitSha,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return null
  })

  try {
    // Idempotency is inherited entirely from releaseRepository.create()'s
    // existing buildReleaseId(service, runId, runAttempt) + SET-NX (KV) /
    // existing-record check (file/memory) — a re-run bumps runAttempt into a
    // genuinely new id, and a repeated poll/webhook delivery for the SAME
    // attempt dedupes instead of creating a duplicate. No new idempotency
    // mechanism needed.
    const result = await createRelease({
      service,
      source: 'github-actions',
      branch: run.branch,
      commitSha: run.commitSha,
      commitMessage,
      githubRunId: run.runId,
      githubRunAttempt: run.runAttempt ?? 1,
      dockerRepository,
      repoDigest: dockerHub.repoDigest,
      tag: dockerHub.tag,
      createdBy,
    })
    return { outcome: 'created', result }
  } catch (error) {
    if (error instanceof ReleaseConflictError) {
      // Same run+attempt already has a DIFFERENT stored release (e.g. Docker
      // Hub's tag moved between two observations of the same attempt) —
      // surfaced as a loud log, not thrown, so it never breaks the caller.
      console.error('[releaseSnapshotFromBuild] release conflict — not overwritten', { service, runId: run.runId, releaseId: error.releaseId })
      return { outcome: 'conflict', releaseId: error.releaseId }
    }
    throw error
  }
}

/**
 * Retries createReleaseSnapshotForCompletedBuild specifically on
 * 'digest_not_found' — the one outcome where trying again can plausibly
 * change the result (Docker Hub indexing catches up). Every other outcome
 * returns immediately, no retry. `sleep` is injectable so tests never wait
 * on a real timer.
 */
export async function createReleaseSnapshotWithRetry(
  run: BuildRunSnapshot,
  service: BuildServiceCode,
  createdBy: string,
  options: CreateSnapshotOptions & { delaysMs?: number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<SnapshotOutcome> {
  const delaysMs = options.delaysMs ?? [2000, 4000, 8000]
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

  let outcome = await createReleaseSnapshotForCompletedBuild(run, service, createdBy, options)
  for (const delayMs of delaysMs) {
    if (outcome.outcome !== 'digest_not_found') return outcome
    await sleep(delayMs)
    outcome = await createReleaseSnapshotForCompletedBuild(run, service, createdBy, options)
  }
  return outcome
}
