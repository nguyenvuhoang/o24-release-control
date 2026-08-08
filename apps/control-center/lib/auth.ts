import { createHmac, createHash, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'

const COOKIE_NAME = 'o24_release_session'
const SESSION_SECONDS = 12 * 60 * 60

type SessionPayload = {
  username: string
  exp: number
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

export function validateCredentials(username: string, password: string): boolean {
  const expectedUsername = process.env.ADMIN_USERNAME ?? 'admin'
  const expectedPassword = process.env.ADMIN_PASSWORD ?? ''
  if (!expectedPassword) return false

  const usernameA = createHash('sha256').update(username).digest()
  const usernameB = createHash('sha256').update(expectedUsername).digest()
  const passwordA = createHash('sha256').update(password).digest()
  const passwordB = createHash('sha256').update(expectedPassword).digest()

  return timingSafeEqual(usernameA, usernameB) && timingSafeEqual(passwordA, passwordB)
}

export async function createSession(username: string): Promise<void> {
  const payload: SessionPayload = {
    username,
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const value = `${encoded}.${sign(encoded)}`
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
    if (!payload.username || payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}
