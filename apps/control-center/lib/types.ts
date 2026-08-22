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
  digest?: string
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

export type RegistryServiceStatus = {
  service: BuildServiceCode
  dockerRepository: string
  /** Undefined only if the Docker Hub lookup itself failed or found no "latest" tag. */
  dockerHub?: DockerHubTagInfo
  latestRelease?: ReleaseSnapshot
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
