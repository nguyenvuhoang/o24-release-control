/**
 * In-memory, best-effort guard against firing two overlapping deploy/rollback
 * requests for the same service+environment from control-center — the same
 * lifecycle/tradeoff as github/dispatchLock.ts and the promoteContexts Map in
 * operationContext.ts (resets on process restart, doesn't survive across
 * serverless instances). This is a UX safety net, NOT the actual data-safety
 * guarantee: the Deploy Agent itself serializes every deploy/restart/rollback
 * on a given agent through its own mutex (see main.go's `a.mu`), so a race
 * here can at worst produce two operationIds that execute back-to-back on the
 * agent — never a corrupted/interleaved deployment.
 */

const locks = new Map<string, number>()

// Comfortably longer than the agent's own 10-minute deploy timeout (see
// runDeploy in main.go), so a lock can never outlive a real in-flight
// operation, but still self-heals if release() is never called (e.g. the
// process restarts mid-operation).
const STALE_AFTER_MS = 15 * 60 * 1000

function lockKey(environment: string, service: string): string {
  return `${environment}:${service}`
}

export function isOperationLocked(environment: string, service: string): boolean {
  const lockedAt = locks.get(lockKey(environment, service))
  return lockedAt !== undefined && Date.now() - lockedAt < STALE_AFTER_MS
}

/** Returns false (and does nothing) if already locked — caller should reject the request. */
export function tryAcquireOperationLock(environment: string, service: string): boolean {
  const key = lockKey(environment, service)
  const lockedAt = locks.get(key)
  if (lockedAt !== undefined && Date.now() - lockedAt < STALE_AFTER_MS) return false
  locks.set(key, Date.now())
  return true
}

export function releaseOperationLock(environment: string, service: string): void {
  locks.delete(lockKey(environment, service))
}
