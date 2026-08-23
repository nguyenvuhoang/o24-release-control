// Deliberately does NOT import 'next/headers' or anything else that only
// resolves inside a Next.js/webpack build — this file's logic (credential
// checking, cookie sign/verify) is pure enough to unit-test directly with
// `node:test`. The `cookies()`-touching wrappers live in sessionCookies.ts.
import { createHmac, createHash, timingSafeEqual } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { getUserRepository, type UserRepository, type UserRole } from './userRepository'

export const SESSION_SECONDS = 12 * 60 * 60

export type SessionPayload = {
  username: string
  role: UserRole
  mustChangePassword: boolean
  exp: number
}

export type AuthenticatedIdentity = {
  username: string
  role: UserRole
  mustChangePassword: boolean
}

function getSecret(): string {
  const secret = process.env.SESSION_SECRET ?? ''
  if (secret.length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 characters')
  }
  return secret
}

function sign(payload: string): string {
  return createHmac('sha256', getSecret()).update(payload).digest('base64url')
}

// Unchanged from before the multi-user migration — the env-based admin
// login must keep working exactly as it did, byte for byte, regardless of
// whether Redis/a user store is configured at all.
function matchesEnvAdmin(username: string, password: string): boolean {
  const expectedUsername = process.env.ADMIN_USERNAME ?? 'admin'
  const expectedPassword = process.env.ADMIN_PASSWORD ?? ''
  if (!expectedPassword) return false

  const usernameA = createHash('sha256').update(username).digest()
  const usernameB = createHash('sha256').update(expectedUsername).digest()
  const passwordA = createHash('sha256').update(password).digest()
  const passwordB = createHash('sha256').update(expectedPassword).digest()

  return timingSafeEqual(usernameA, usernameB) && timingSafeEqual(passwordA, passwordB)
}

// Safe to log: a category label + the (already-not-secret) attempted
// username. NEVER the password or a password hash. The client-facing
// response (app/api/auth/login/route.ts) stays the single generic "Tên
// đăng nhập hoặc mật khẩu không đúng" regardless of which of these fired —
// this is purely for server-side diagnosis (see the linhnq login
// investigation this was added for). 'user_disabled' is reserved for a
// future `enabled` flag on UserRecord — no such flag exists yet, so this
// reason can never actually fire today; it's listed so a future disable
// feature has an obvious place to log into.
export type LoginFailureReason = 'no_user_store_configured' | 'user_not_found' | 'user_disabled' | 'password_mismatch'

function defaultLogLoginFailure(reason: LoginFailureReason, context: { username: string }): void {
  console.error('[auth] login failed', { reason, username: context.username })
}

/**
 * Tries the env-based admin account first (unchanged behavior — always
 * available regardless of Redis config), then falls back to the Redis user
 * store (see lib/userRepository.ts) with a bcrypt-verified password. Returns
 * null on any mismatch — the CALLER never sees which reason applied (see
 * LoginFailureReason's doc comment), only `logFailure` does.
 *
 * `userRepositoryOverride`/`logFailure` exist purely for tests to inject a
 * fake repository (or `null` to simulate "Redis not configured") and to
 * assert on which reason fired without polluting real console output —
 * real callers never pass either, letting this resolve the real
 * repository and log to the real console itself.
 */
export async function validateCredentials(
  username: string,
  password: string,
  userRepositoryOverride?: UserRepository | null,
  logFailure: (reason: LoginFailureReason, context: { username: string }) => void = defaultLogLoginFailure,
): Promise<AuthenticatedIdentity | null> {
  if (matchesEnvAdmin(username, password)) {
    return { username: process.env.ADMIN_USERNAME ?? 'admin', role: 'admin', mustChangePassword: false }
  }

  const userRepository = userRepositoryOverride !== undefined ? userRepositoryOverride : getUserRepository()
  if (!userRepository) {
    logFailure('no_user_store_configured', { username })
    return null
  }

  const record = await userRepository.getByUsername(username)
  if (!record) {
    logFailure('user_not_found', { username })
    return null
  }

  const matches = await bcrypt.compare(password, record.passwordHash)
  if (!matches) {
    logFailure('password_mismatch', { username: record.username })
    return null
  }

  return { username: record.username, role: record.role, mustChangePassword: record.mustChangePassword }
}

/**
 * Pure HMAC-sign-and-encode — factored out of createSession so the cookie
 * format (and the role/mustChangePassword propagation into it) is directly
 * unit-testable without Next's request-scoped `cookies()` API, matching this
 * codebase's convention of testing pure logic directly (see
 * useBuildTracker's deriveBuildUpdate, releaseComparison.ts, etc.).
 */
export function encodeSessionCookie(identity: AuthenticatedIdentity, nowSeconds: number = Math.floor(Date.now() / 1000)): string {
  const payload: SessionPayload = {
    username: identity.username,
    role: identity.role,
    mustChangePassword: identity.mustChangePassword,
    exp: nowSeconds + SESSION_SECONDS,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${sign(encoded)}`
}

/** Pure verify-and-decode counterpart to encodeSessionCookie — see its doc comment. */
export function decodeSessionCookie(value: string, nowSeconds: number = Math.floor(Date.now() / 1000)): SessionPayload | null {
  const [encoded, signature] = value.split('.')
  if (!encoded || !signature) return null

  const expected = sign(encoded)
  const signatureBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)
  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload
    // (payload.role !== 'admin' && payload.role !== 'user') also rejects a
    // pre-migration cookie that has no `role` at all — those simply expire
    // within SESSION_SECONDS anyway, this just fails them closed sooner.
    if (!payload.username || (payload.role !== 'admin' && payload.role !== 'user') || payload.exp < nowSeconds) {
      return null
    }
    return payload
  } catch {
    return null
  }
}

