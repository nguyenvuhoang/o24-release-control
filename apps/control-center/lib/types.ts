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
