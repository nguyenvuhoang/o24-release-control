// Pure access-decision logic for API routes — deliberately separate from
// lib/api.ts, which transitively imports 'next/headers' (via
// sessionCookies.ts) and therefore can't be unit-tested outside a Next.js
// build. Every one of the 20 protected API routes already funnels through
// requireApiSession() in lib/api.ts, so gating mustChangePassword HERE means
// Build/Deploy/Promote/Restart/Rollback/Monitoring/Audit are all covered by
// this one change point — no per-route edits needed.

export type ApiAccessSession = { mustChangePassword: boolean }

export type ApiAccessOptions = {
  /** Set by the small number of routes a must-change-password user still needs: session/current-user, change-password. Logout doesn't call requireApiSession at all. */
  allowPasswordChangeRequired?: boolean
}

export type ApiAccessDecision = { allowed: true } | { allowed: false; status: 401 | 403; error: 'unauthorized' | 'password_change_required' }

export function decideApiAccess(session: ApiAccessSession | null, options: ApiAccessOptions = {}): ApiAccessDecision {
  if (!session) {
    return { allowed: false, status: 401, error: 'unauthorized' }
  }
  if (session.mustChangePassword && !options.allowPasswordChangeRequired) {
    return { allowed: false, status: 403, error: 'password_change_required' }
  }
  return { allowed: true }
}
