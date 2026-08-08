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
  image: string
  imageId: string
  digest?: string
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
