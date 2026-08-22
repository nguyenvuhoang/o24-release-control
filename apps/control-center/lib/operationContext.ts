/**
 * Remembers which agent operationIds were started by a promote request, so
 * the shared operations-status route can still record a `promote` audit
 * entry (with source/target environment) instead of the generic `deploy`
 * action the target agent itself reports. In-memory only, same lifecycle as
 * the existing audit-dedup Set in the operations route.
 */
type PromoteContext = {
  sourceEnvironment: string
  targetEnvironment: string
}

const promoteContexts = new Map<string, PromoteContext>()

export function registerPromoteOperation(operationId: string, context: PromoteContext): void {
  promoteContexts.set(operationId, context)
}

export function getPromoteContext(operationId: string): PromoteContext | undefined {
  return promoteContexts.get(operationId)
}

/**
 * Same idea as PromoteContext above, for an operation dispatched by
 * POST /api/releases/[id]/deploy (redeploy or rollback-to-release): the
 * operations-status route reads this once the agent reports a terminal
 * status, so the audit record can carry the release id and the digest
 * before/after, and so `action` reads as "redeploy"/"rollback" instead of
 * the agent's generic "deploy". Cleared after that single read — unlike
 * promoteContexts, this one also gates lib/operationLock.ts's release, so it
 * must not silently grow unbounded across a long-running process.
 */
export type ReleaseOperationContext = {
  releaseId: string
  service: string
  environment: string
  action: 'redeploy' | 'rollback'
  toRepoDigest: string
  fromRepoDigest?: string
}

const releaseOperationContexts = new Map<string, ReleaseOperationContext>()

export function registerReleaseOperation(operationId: string, context: ReleaseOperationContext): void {
  releaseOperationContexts.set(operationId, context)
}

export function getReleaseOperationContext(operationId: string): ReleaseOperationContext | undefined {
  return releaseOperationContexts.get(operationId)
}

export function clearReleaseOperationContext(operationId: string): void {
  releaseOperationContexts.delete(operationId)
}
