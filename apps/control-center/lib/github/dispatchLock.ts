// In-memory guard against accidental double-submit (e.g. a fast double
// click) triggering two workflow runs for the same service. Same lifecycle
// and tradeoffs as the audit-dedup Set in the operations route: resets on
// process restart, which is fine since it only needs to survive a few
// seconds per service.
const recentDispatches = new Map<string, number>()
const DISPATCH_COOLDOWN_MS = 5000

export function isDispatchLocked(service: string): boolean {
  const last = recentDispatches.get(service)
  return last !== undefined && Date.now() - last < DISPATCH_COOLDOWN_MS
}

export function markDispatched(service: string): void {
  recentDispatches.set(service, Date.now())
}
