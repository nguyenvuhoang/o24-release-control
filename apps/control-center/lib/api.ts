import { NextResponse } from 'next/server'
import { getSession } from './auth'

export async function requireApiSession(): Promise<{ username: string } | NextResponse> {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  return { username: session.username }
}

export function errorResponse(error: unknown, status = 500): NextResponse {
  const message = error instanceof Error ? error.message : 'Unknown error'
  return NextResponse.json({ error: 'request_failed', details: message }, { status })
}
