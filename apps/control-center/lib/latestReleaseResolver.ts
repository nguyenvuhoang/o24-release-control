import { fetchDockerHubTagDigest } from './dockerHub'
import { findLatestGithubRunForService } from './github/client'
import { imageRepositoryFor, type BuildServiceCode } from './github/serviceMap'
import { getLatestBuildIntent } from './buildPointerStore'
import { getReleaseRepository } from './releaseRepository'
import type { BuildIntent, BuildRunSnapshot, DockerHubTagInfo, ReleaseSnapshot, ResolvedRelease } from './types'

/**
 * Resolves "what is actually the latest build" for one service — the whole
 * point being that GitHub Actions is NOT assumed to be the only place a
 * build can come from (Telegram, a direct GitHub-UI dispatch/Re-run, or a
 * manual build pushed straight to Docker Hub are all real paths — see the
 * doc comments on ReleaseSource/dockerHub.ts). The one thing that's always
 * true regardless of origin is: whatever Docker Hub's `latest` tag currently
 * points to IS the latest build. Everything else (branch, commit, who/what
 * built it) is enrichment layered on top of that digest, never a substitute
 * for it — nothing here ever resolves "latest" by tag, imageId or a build
 * timestamp alone.
 */

type ClassifyInput = {
  service: BuildServiceCode
  dockerRepository: string
  dockerHub: DockerHubTagInfo
  matchedSnapshot: ReleaseSnapshot | null
  githubRun: BuildRunSnapshot | null
  matchingBuildIntent: BuildIntent | null
  discoveredAt: string
}

/**
 * Pure decision logic, factored out from all I/O so the "which source wins"
 * policy is directly unit-testable. Two cases carry real metadata:
 *
 *  1. matchedSnapshot: a ReleaseSnapshot's repoDigest is EXACTLY Docker
 *     Hub's current digest (via releaseRepository.getByDigest) — the
 *     strongest evidence available. If that snapshot came from a GitHub
 *     Actions run AND control-center's own BuildIntent record shows it
 *     dispatched that run, source is 'release-control'; otherwise 'github'
 *     (found the run, but didn't dispatch it — GitHub UI, a Re-run, or
 *     Telegram calling the GitHub API directly all look identical here).
 *     A docker-registry-sourced snapshot is always 'external' — it was
 *     found purely by scanning the registry, nothing about its origin.
 *
 *  2. githubRun (no matched snapshot): the newest GitHub Actions run whose
 *     title mentions this service (see findLatestGithubRunForService) —
 *     used ONLY as a fallback when nothing proves what produced the current
 *     digest. GitHub's REST API cannot confirm a specific run produced a
 *     specific registry digest (no digest appears on a run object at all),
 *     so this is explicitly advisory: branch/commitSha here describe that
 *     run, not a verified property of the digest. `createdAt` is
 *     deliberately omitted in this branch for the same reason.
 *
 *  Neither found: source 'unknown' — only the digest itself is known.
 */
export function classifyLatestRelease(input: ClassifyInput): ResolvedRelease {
  const { service, dockerRepository, dockerHub, matchedSnapshot, githubRun, matchingBuildIntent, discoveredAt } = input

  if (matchedSnapshot) {
    const dispatchedByReleaseControl =
      matchedSnapshot.source === 'github-actions' &&
      matchingBuildIntent != null &&
      matchingBuildIntent.runId === matchedSnapshot.githubRunId
    return {
      service,
      repository: dockerRepository,
      tag: dockerHub.tag,
      repoDigest: dockerHub.repoDigest,
      source: matchedSnapshot.source === 'docker-registry' ? 'external' : dispatchedByReleaseControl ? 'release-control' : 'github',
      snapshotId: matchedSnapshot.id,
      workflowRunId: matchedSnapshot.githubRunId ?? undefined,
      branch: matchedSnapshot.branch ?? undefined,
      commitSha: matchedSnapshot.commitSha ?? undefined,
      createdAt: matchedSnapshot.createdAt,
      discoveredAt,
    }
  }

  if (githubRun) {
    const dispatchedByReleaseControl = matchingBuildIntent != null && matchingBuildIntent.runId === githubRun.runId
    return {
      service,
      repository: dockerRepository,
      tag: dockerHub.tag,
      repoDigest: dockerHub.repoDigest,
      source: dispatchedByReleaseControl ? 'release-control' : 'github',
      workflowRunId: githubRun.runId,
      workflowRunUrl: githubRun.htmlUrl,
      branch: githubRun.branch,
      commitSha: githubRun.commitSha,
      discoveredAt,
    }
  }

  return {
    service,
    repository: dockerRepository,
    tag: dockerHub.tag,
    repoDigest: dockerHub.repoDigest,
    source: 'unknown',
    discoveredAt,
  }
}

type ResolveOptions = {
  /**
   * Pass the already-fetched Docker Hub result (including `null` for
   * "already tried, found nothing") when the caller fetched it anyway for
   * its own purposes — avoids a duplicate Docker Hub API call. Omit to let
   * this function fetch it itself.
   */
  dockerHub?: DockerHubTagInfo | null
  // The three lookups below default to the real repository/GitHub/BuildIntent
  // calls — overridable purely so resolveLatestRelease's branching can be
  // unit-tested without live KV/GitHub credentials (see
  // latestReleaseResolver.test.ts), not because any real caller needs to
  // swap them.
  getByDigest?: (service: BuildServiceCode, repoDigest: string) => Promise<ReleaseSnapshot | undefined>
  findLatestGithubRunForService?: (service: string) => Promise<BuildRunSnapshot | null>
  getLatestBuildIntent?: (service: string) => Promise<BuildIntent | undefined>
}

/**
 * Full resolver: Docker Hub digest -> exact ReleaseSnapshot match -> GitHub
 * Actions run fallback -> unknown. Returns null only when Docker Hub itself
 * has nothing to resolve from (no repository/tag, or the lookup failed) —
 * there is no "latest build" to report at all in that case.
 */
export async function resolveLatestRelease(service: BuildServiceCode, options: ResolveOptions = {}): Promise<ResolvedRelease | null> {
  const dockerRepository = imageRepositoryFor(service)
  const dockerHub =
    options.dockerHub !== undefined
      ? options.dockerHub
      : await fetchDockerHubTagDigest(dockerRepository).catch((error) => {
          console.error('[latestReleaseResolver] Docker Hub lookup failed', {
            service,
            dockerRepository,
            error: error instanceof Error ? error.message : 'Unknown error',
          })
          return null
        })
  if (!dockerHub) return null

  const lookupByDigest = options.getByDigest ?? ((svc, digest) => getReleaseRepository().getByDigest(svc, digest))
  const scanGithubRuns = options.findLatestGithubRunForService ?? findLatestGithubRunForService
  const lookupBuildIntent = options.getLatestBuildIntent ?? getLatestBuildIntent

  const discoveredAt = new Date().toISOString()
  const matchedSnapshot = (await lookupByDigest(service, dockerHub.repoDigest).catch(() => undefined)) ?? null

  if (matchedSnapshot) {
    // A BuildIntent lookup is only meaningful for a github-actions snapshot
    // (docker-registry ones are always 'external' — see classifyLatestRelease).
    const matchingBuildIntent =
      matchedSnapshot.source === 'github-actions' ? (await lookupBuildIntent(service).catch(() => undefined)) ?? null : null
    return classifyLatestRelease({ service, dockerRepository, dockerHub, matchedSnapshot, githubRun: null, matchingBuildIntent, discoveredAt })
  }

  const githubRun = await scanGithubRuns(service).catch((error) => {
    console.error('[latestReleaseResolver] GitHub run scan failed', {
      service,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return null
  })
  if (githubRun) {
    const matchingBuildIntent = (await lookupBuildIntent(service).catch(() => undefined)) ?? null
    return classifyLatestRelease({ service, dockerRepository, dockerHub, matchedSnapshot: null, githubRun, matchingBuildIntent, discoveredAt })
  }

  return classifyLatestRelease({ service, dockerRepository, dockerHub, matchedSnapshot: null, githubRun: null, matchingBuildIntent: null, discoveredAt })
}
