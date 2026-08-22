import type { BuildServiceCode } from './github/serviceMap'

export type EnvironmentConfig = {
  code: string
  name: string
  baseUrl: string
  apiKey: string
  apiSecret: string
  order: number
  enabled?: boolean
  cfAccessClientId?: string
  cfAccessClientSecret?: string
}

export type ControlConfig = {
  applicationName?: string
  environments: EnvironmentConfig[]
}

export type AgentStatus = {
  environment: string
  agentVersion: string
  dockerAvailable: boolean
  composeVersion?: string
  startedAt: string
  timestamp: string
}

export type ServiceStatus = {
  code: string
  displayName: string
  composeService: string
  containerName: string
  status: string
  health: string
  /** The reference the container was actually started from (e.g. "repo@sha256:..." or "repo:latest"). */
  imageRef: string
  /** Local Docker image ID (container inspect .Image). NOT a registry digest — debug/technical detail only. */
  imageId: string
  /** Immutable registry digest ("sha256:..."). The only identifier safe for promotion and DEV/UAT comparisons. */
  repoDigest?: string
  gitRevision?: string
  startedAt?: string
  configuredImage?: string
  error?: string
}

export type EnvironmentDashboard = {
  code: string
  name: string
  order: number
  online: boolean
  error?: string
  agent?: AgentStatus
  services: ServiceStatus[]
}

export type DashboardResponse = {
  applicationName: string
  generatedAt: string
  environments: EnvironmentDashboard[]
  buildBranch: string
}

export type AuditRecord = {
  id: string
  timestamp: string
  username: string
  action: string
  environment?: string
  sourceEnvironment?: string
  targetEnvironment?: string
  service?: string
  /** The digest AFTER the operation — kept for backward compatibility with existing readers. */
  digest?: string
  /** The digest that was running in `environment` immediately before this operation, if known. */
  fromDigest?: string
  /** The digest this operation deployed — same value as `digest` when set. */
  toDigest?: string
  /** The ReleaseSnapshot id this operation deployed to/rolled back to, if it was release-driven. */
  releaseId?: string
  status: 'succeeded' | 'failed'
  error?: string
  details?: unknown
}

export type OperationAction = 'deploy' | 'restart' | 'rollback'
export type OperationStatus = 'running' | 'success' | 'failed'

export type OperationLogLine = {
  index: number
  timestamp: string
  message: string
}

export type OperationStartResponse = {
  operationId: string
  status: 'running'
}

export type OperationSnapshot = {
  operationId: string
  environment: string
  service: string
  action: OperationAction
  image?: string
  status: OperationStatus
  startedAt: string
  completedAt?: string
  error?: string
  logs: OperationLogLine[]
}

// GitHub Actions build trigger (source -> docker build -> Docker Hub). This is
// intentionally separate from OperationSnapshot/OperationAction above: a
// build never touches a running container, and is tracked independently of
// deploy/restart/rollback/promote operations.
export type BuildTriggerResponse = {
  success: true
  service: string
  tag: string
  branch: string
  runId: number
  runUrl: string
  htmlUrl: string
}

export type BuildTriggerError = {
  success: false
  error: string
  details?: string
}

export type BuildRunStatus = 'queued' | 'in_progress' | 'completed'
export type BuildConclusion = 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | 'stale' | 'neutral' | null

export type BuildRunSnapshot = {
  runId: number
  status: BuildRunStatus
  conclusion: BuildConclusion
  htmlUrl: string
  branch: string
  commitSha: string
  createdAt: string
  updatedAt: string
  // GitHub increments this every time a run is re-run ("Re-run failed jobs",
  // "Re-run all jobs"), while runId itself stays the same — required to tell
  // a fresh re-run attempt apart from the original attempt that produced it.
  runAttempt?: number
}

// Response of GET /api/builds/latest?service=<code> — server-side discovery
// of the newest GitHub Actions run for a service, so the UI never needs to
// rely on having seen/remembered a runId itself (see docs on
// findLatestGithubRunForService for how "newest run for this service" is
// determined). runId is null when no run could be found for the service at
// all — a real, valid answer ("no build has happened yet"), not an error.
export type LatestBuildResponse = { service: string; runId: null } | ({ service: string } & BuildRunSnapshot)

export type BuildJobStepStatus = 'queued' | 'in_progress' | 'completed'

export type BuildJobStep = {
  name: string
  status: BuildJobStepStatus
  conclusion: BuildConclusion
  number: number
}

export type BuildJob = {
  id: number
  name: string
  status: BuildJobStepStatus
  conclusion: BuildConclusion
  steps: BuildJobStep[]
}

export type BuildJobsResponse = {
  runId: number
  jobs: BuildJob[]
}

// Where a ReleaseSnapshot's repoDigest was learned from: a GitHub Actions
// build this app dispatched/observed, or a scan of Docker Hub that found an
// image nobody told control-center about (see lib/dockerHub.ts and
// /api/registry/*) — team members sometimes build from Telegram or the DEV
// server and push straight to Docker Hub, bypassing GitHub Actions entirely.
export type ReleaseSource = 'github-actions' | 'docker-registry'

// An immutable record of a built-and-pushed image. github-actions releases
// are keyed deterministically by service+run+attempt (see buildReleaseId in
// releaseRepository.ts); docker-registry releases are keyed by the digest
// itself (see buildRegistryReleaseId) since they have no run to key off —
// branch/commitSha/githubRunId/githubRunAttempt are unknowable for those and
// stay null.
export type ReleaseSnapshot = {
  id: string
  service: BuildServiceCode
  source: ReleaseSource
  branch: string | null
  commitSha: string | null
  /**
   * The commit's message, when a source can supply one. Nothing currently
   * populates this (see ReleaseSource doc) — reserved so a future
   * github-actions release-creation path can fill it in without a schema
   * change. Always shown as "not available" until then.
   */
  commitMessage?: string | null
  dockerRepository: string
  repoDigest: string
  tag: string
  githubRunId: number | null
  githubRunAttempt: number | null
  createdAt: string
  createdBy: string
  /** Set only for source: 'docker-registry' — when the Docker Hub scan found this digest. */
  discoveredAt?: string
}

// Recorded the moment control-center successfully dispatches a GitHub
// Actions build — "who asked for this build, and what did they ask for" —
// independent of whether/when that run ever produces a ReleaseSnapshot.
export type BuildIntent = {
  runId: number
  service: BuildServiceCode
  branch: string
  tag: string
  requestedBy: string
  requestedAt: string
}

// Normalized "what is actually running in this environment right now" for
// one service — see lib/releaseComparison.ts's toRunningRelease. Built from
// whatever the Deploy Agent's live /api/services already reports (never
// Docker local imageId), combined with a ReleaseSnapshot lookup by digest.
export type RunningRelease = {
  environment: 'DEV' | 'UAT' | 'PROD' | string
  service: BuildServiceCode
  repository?: string
  tag?: string
  repoDigest?: string
  snapshotId?: string
  containerStatus: 'running' | 'stopped' | 'missing' | 'unknown'
  checkedAt: string
  /** Set when the environment/agent could not be checked at all — distinct from "missing" (checked, service just isn't deployed there). */
  error?: string
}

// The Version Comparison state machine's headline verdict for one service —
// see lib/releaseComparison.ts's resolveReleaseComparison (a pure function,
// unit-tested; never re-implemented ad hoc in a component). `warnings`
// carries every OTHER relationship (UAT-vs-DEV, PROD-vs-UAT, "can't check
// UAT") that didn't become the headline, so nothing observed is silently
// dropped just because it wasn't chosen as `state`.
export type ReleaseComparisonState =
  | 'NEW_BUILD_AVAILABLE'
  | 'DEV_SYNCED'
  | 'DEV_OUTDATED'
  | 'UAT_SYNCED_WITH_DEV'
  | 'UAT_DIFFERS_FROM_DEV'
  | 'UAT_AHEAD_OR_UNKNOWN'
  | 'PROD_SYNCED_WITH_UAT'
  | 'PROD_DIFFERS_FROM_UAT'
  | 'UNTRACKED_BUILD'
  | 'ENVIRONMENT_UNAVAILABLE'
  | 'NO_BUILD'
  | 'UNKNOWN'

export type ReleaseComparison = {
  state: ReleaseComparisonState
  latest?: ResolvedRelease
  dev?: RunningRelease
  uat?: RunningRelease
  prod?: RunningRelease
  canImportSnapshot: boolean
  canDeployLatestToDev: boolean
  canPromoteDevToUat: boolean
  canPromoteUatToProd: boolean
  warnings: string[]
}

// GET /api/registry/status — per-service comparison between Docker Hub's
// current "latest" tag and Release Control's own record of it. DEV/UAT/PROD
// digests are deliberately NOT included here: the client already has them
// from /api/dashboard and derives the comparison from that, so this endpoint
// doesn't have to call every Deploy Agent a second time just to answer it.
export type DockerHubTagInfo = {
  repoDigest: string
  tag: string
  lastUpdated?: string
}

// Where a resolved "latest build" was pinned down from — see
// lib/latestReleaseResolver.ts. Distinct from ReleaseSource: ReleaseSource
// describes how a *stored* ReleaseSnapshot was learned about (github-actions
// vs docker-registry scan); ResolvedRelease.source describes how confident
// the resolver is that it knows what produced the CURRENT Docker Hub digest.
//   - 'release-control': a ReleaseSnapshot or GitHub Actions run was found
//     that matches, AND control-center's own BuildIntent record shows it
//     dispatched that exact run.
//   - 'github': a GitHub Actions run/snapshot was found, but nothing shows
//     control-center dispatched it (GitHub UI, a Re-run, or Telegram calling
//     the GitHub API directly all look identical from here).
//   - 'telegram': reserved for forward-compatibility. Nothing in this
//     codebase can currently distinguish a Telegram-triggered GitHub Actions
//     run from any other externally-triggered one (GitHub's REST API
//     exposes no such signal — see github/client.ts) — this value is never
//     produced today, and MUST NOT be guessed at with a heuristic.
//   - 'external': the digest is only known via a docker-registry
//     ReleaseSnapshot (Docker Registry Sync) — pushed straight to Docker Hub
//     outside anything control-center observed.
//   - 'unknown': the digest exists on Docker Hub but nothing (no snapshot,
//     no matching GitHub run) is known about where it came from.
export type ResolvedReleaseSource = 'release-control' | 'github' | 'telegram' | 'external' | 'unknown'

// The result of lib/latestReleaseResolver.ts — "what is actually the latest
// build for this service right now", anchored to Docker Hub's current
// digest (never a tag, never a build timestamp alone — see the module for
// why). branch/commitSha/workflowRun* are enrichment, populated only when
// they're either exactly tied to a matching ReleaseSnapshot, or (source:
// 'github') a best-effort association the resolver could not verify against
// the digest itself — see classifyLatestRelease's doc comment.
export type ResolvedRelease = {
  service: BuildServiceCode
  repository: string
  tag: string
  repoDigest: string
  source: ResolvedReleaseSource
  snapshotId?: string
  workflowRunId?: number
  workflowRunUrl?: string
  branch?: string
  commitSha?: string
  createdAt?: string
  discoveredAt: string
}

export type RegistryServiceStatus = {
  service: BuildServiceCode
  dockerRepository: string
  /** Undefined only if the Docker Hub lookup itself failed or found no "latest" tag. */
  dockerHub?: DockerHubTagInfo
  latestRelease?: ReleaseSnapshot
  /** Undefined only when Docker Hub itself has no "latest" tag to resolve from — see resolveLatestRelease. */
  latestBuild?: ResolvedRelease
}

export type RegistryStatusResponse = {
  generatedAt: string
  services: RegistryServiceStatus[]
}

export type RegistrySyncResponse = {
  success: true
  release: ReleaseSnapshot
  deduped: boolean
}

// GET /api/releases — the Version Timeline for one service, newest first.
// branch/source/since/until are applied AFTER the underlying sorted-by-time
// page is read (see releaseRepository.ts) — a page can come back with fewer
// than `limit` items even though more matches exist further back; the
// client keeps requesting nextCursor to page through.
export type ReleaseTimelineResponse = {
  items: ReleaseSnapshot[]
  nextCursor?: string
}

// POST /api/releases/environment-state — client supplies each environment's
// LIVE repoDigest (already fresh from /api/dashboard); the server's only job
// is resolving each digest to a known ReleaseSnapshot via the digest index.
// This is read-only and has no side effects, so trusting the client-supplied
// digest here is fine — it never feeds a deploy (see /api/releases/[id]/deploy,
// which always re-loads the digest from the stored snapshot itself).
export type ReleaseEnvironmentStateRequest = {
  service: string
  environments: { code: string; repoDigest?: string }[]
}

export type ReleaseEnvironmentState = {
  environment: string
  repoDigest?: string
  /** null when repoDigest is set but no known ReleaseSnapshot matches it — the "Không đồng bộ" case. */
  release: ReleaseSnapshot | null
}

export type ReleaseEnvironmentStateResponse = {
  items: ReleaseEnvironmentState[]
}

// GET /api/releases/[id]/history — deployment operations (deploy/promote/
// restart/rollback/redeploy) that touched this release's digest, newest
// first. Sourced from the audit trail's bounded recent-record window (see
// auditRepository.ts) — an old release whose last touch has aged out of that
// window will show no history rows, not an error.
export type ReleaseHistoryEntry = AuditRecord

export type ReleaseHistoryResponse = {
  releaseId: string
  items: ReleaseHistoryEntry[]
}

// POST /api/releases/[id]/deploy — "deploy lại" and "rollback tới release cụ
// thể" are the same underlying action (deploy this release's immutable
// digest); intent only changes labeling/audit action and whether the
// "already running this digest" guard is enforced (rollback) or advisory
// (redeploy).
export type ReleaseDeployIntent = 'redeploy' | 'rollback'

export type ReleaseDeployRequest = {
  environment: string
  intent?: ReleaseDeployIntent
}

export type ReleaseDeployResponse = {
  operationId: string
  status: 'running'
  environment: string
  service: string
  releaseId: string
  fromRepoDigest?: string
  toRepoDigest: string
  intent: ReleaseDeployIntent
}
