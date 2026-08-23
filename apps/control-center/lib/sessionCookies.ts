// Thin Next.js cookie plumbing around lib/auth.ts's pure sign/verify logic —
// split out specifically so lib/auth.ts stays importable (and testable)
// outside a Next.js/webpack build; `next/headers`'s `cookies()` only
// resolves inside one.
import { cookies } from 'next/headers'
import { decodeSessionCookie, encodeSessionCookie, SESSION_SECONDS, type AuthenticatedIdentity, type SessionPayload } from './auth'

const COOKIE_NAME = 'o24_release_session'

export async function createSession(identity: AuthenticatedIdentity): Promise<void> {
  const value = encodeSessionCookie(identity)
  const store = await cookies()
  store.set(COOKIE_NAME, value, {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE !== 'false',
    sameSite: 'strict',
    maxAge: SESSION_SECONDS,
    path: '/',
  })
}

export async function clearSession(): Promise<void> {
  const store = await cookies()
  store.set(COOKIE_NAME, '', { httpOnly: true, maxAge: 0, path: '/' })
}

export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies()
  const value = store.get(COOKIE_NAME)?.value
  if (!value) return null
  return decodeSessionCookie(value)
}
