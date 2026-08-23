import { NextResponse } from 'next/server'
import { decideApiAccess, type ApiAccessOptions } from './apiAccess'
import { getSession } from './sessionCookies'
import type { UserRole } from './userRepository'

export async function requireApiSession(
  options?: ApiAccessOptions,
): Promise<{ username: string; role: UserRole; mustChangePassword: boolean } | NextResponse> {
  const session = await getSession()
  const decision = decideApiAccess(session, options)
  if (!decision.allowed) {
    return NextResponse.json({ error: decision.error }, { status: decision.status })
  }
  // session is non-null whenever decision.allowed is true (see decideApiAccess).
  return { username: session!.username, role: session!.role, mustChangePassword: session!.mustChangePassword }
}

export function errorResponse(error: unknown, status = 500): NextResponse {
  const message = error instanceof Error ? error.message : 'Unknown error'
  return NextResponse.json({ error: 'request_failed', details: message }, { status })
}
