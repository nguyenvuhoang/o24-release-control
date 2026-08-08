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
