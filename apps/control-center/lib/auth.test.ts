import assert from 'node:assert/strict'
import test from 'node:test'
import bcrypt from 'bcryptjs'

process.env.SESSION_SECRET = 'a'.repeat(32)
process.env.ADMIN_USERNAME = 'admin'
process.env.ADMIN_PASSWORD = 'super-secret-admin-password'

const { decodeSessionCookie, encodeSessionCookie, validateCredentials } = await import('./auth')

// A tiny fake UserRepository — inline since it's only needed in this file.
type FakeRecord = { username: string; passwordHash: string; role: 'admin' | 'user'; mustChangePassword: boolean; createdAt: string; createdBy: string }

// Mirrors lib/userRepository.ts's normalizeUsername() exactly (trim + lowercase)
// — this fake diverging from the real normalization contract is exactly the
// kind of mock/reality gap that would have masked a real bug here.
function normalizeUsername(username: string): string {
  return username.trim().toLowerCase()
}

class FakeUserRepository {
  private records = new Map<string, FakeRecord>()

  async seed(username: string, plaintextPassword: string, opts: { role?: 'admin' | 'user'; mustChangePassword?: boolean } = {}) {
    this.records.set(normalizeUsername(username), {
      username: normalizeUsername(username),
      passwordHash: await bcrypt.hash(plaintextPassword, 4), // low cost factor — tests only
      role: opts.role ?? 'user',
      mustChangePassword: opts.mustChangePassword ?? true,
      createdAt: new Date().toISOString(),
      createdBy: 'test',
    })
  }

  async getByUsername(username: string) {
    return this.records.get(normalizeUsername(username))
  }

  async createIfAbsent(): Promise<never> {
    throw new Error('not used in these tests')
  }
}

// ---- validateCredentials ----

test('admin-env login still works unchanged: correct ADMIN_USERNAME/ADMIN_PASSWORD succeeds with role admin', async () => {
  const identity = await validateCredentials('admin', 'super-secret-admin-password', null)
  assert.ok(identity)
  assert.equal(identity.username, 'admin')
  assert.equal(identity.role, 'admin')
  assert.equal(identity.mustChangePassword, false)
})

test('admin-env login fails with a wrong password, and does not fall through to a null user repository crashing', async () => {
  const identity = await validateCredentials('admin', 'wrong-password', null)
  assert.equal(identity, null)
})

test('a Redis-backed user logs in successfully with the correct password', async () => {
  const repo = new FakeUserRepository()
  await repo.seed('linhnq', 'linhnq', { role: 'user', mustChangePassword: true })
  const identity = await validateCredentials('linhnq', 'linhnq', repo as never)
  assert.ok(identity)
  assert.equal(identity.username, 'linhnq')
  assert.equal(identity.role, 'user')
  assert.equal(identity.mustChangePassword, true)
})

test('a Redis-backed user fails to log in with the wrong password', async () => {
  const repo = new FakeUserRepository()
  await repo.seed('hoangnv', 'hoangnv')
  const identity = await validateCredentials('hoangnv', 'not-the-right-password', repo as never)
  assert.equal(identity, null)
})

test('an unknown username with no user repository configured (Redis absent) fails closed, not throws', async () => {
  const identity = await validateCredentials('nobody', 'whatever', null)
  assert.equal(identity, null)
})

test('a Redis-backed user with a mixed-case/whitespace username at login still succeeds', async () => {
  const repo = new FakeUserRepository()
  await repo.seed('linhnq', 'linhnq', { role: 'user', mustChangePassword: true })
  const identity = await validateCredentials('  LinhNQ  ', 'linhnq', repo as never)
  assert.ok(identity)
  assert.equal(identity.username, 'linhnq')
})

// ---- safe, distinguishable server-side failure logging (never leaked to the caller's return value) ----

test('logFailure receives "user_not_found" for an unknown username, and the public result is still just null', async () => {
  const repo = new FakeUserRepository()
  const logs: { reason: string; username: string }[] = []
  const identity = await validateCredentials('nobody', 'whatever', repo as never, (reason, ctx) => logs.push({ reason, ...ctx }))
  assert.equal(identity, null)
  assert.deepEqual(logs, [{ reason: 'user_not_found', username: 'nobody' }])
})

test('logFailure receives "password_mismatch" (not "user_not_found") when the user exists but the password is wrong', async () => {
  const repo = new FakeUserRepository()
  await repo.seed('linhnq', 'linhnq')
  const logs: { reason: string; username: string }[] = []
  const identity = await validateCredentials('linhnq', 'totally-wrong', repo as never, (reason, ctx) => logs.push({ reason, ...ctx }))
  assert.equal(identity, null)
  assert.deepEqual(logs, [{ reason: 'password_mismatch', username: 'linhnq' }])
})

test('logFailure receives "no_user_store_configured" when Redis is not set up at all', async () => {
  const logs: { reason: string; username: string }[] = []
  const identity = await validateCredentials('linhnq', 'linhnq', null, (reason, ctx) => logs.push({ reason, ...ctx }))
  assert.equal(identity, null)
  assert.deepEqual(logs, [{ reason: 'no_user_store_configured', username: 'linhnq' }])
})

test('logFailure is never called on a successful login (admin or Redis user)', async () => {
  const repo = new FakeUserRepository()
  await repo.seed('linhnq', 'linhnq')
  const logs: unknown[] = []
  const track = (reason: string, ctx: { username: string }) => logs.push({ reason, ...ctx })

  await validateCredentials('admin', 'super-secret-admin-password', null, track)
  await validateCredentials('linhnq', 'linhnq', repo as never, track)
  assert.deepEqual(logs, [])
})

// ---- encodeSessionCookie / decodeSessionCookie ----

test('encodeSessionCookie -> decodeSessionCookie round-trips username, role and mustChangePassword', () => {
  const cookie = encodeSessionCookie({ username: 'linhnq', role: 'user', mustChangePassword: true })
  const decoded = decodeSessionCookie(cookie)
  assert.ok(decoded)
  assert.equal(decoded.username, 'linhnq')
  assert.equal(decoded.role, 'user')
  assert.equal(decoded.mustChangePassword, true)
})

test('decodeSessionCookie rejects a tampered payload (signature no longer matches)', () => {
  const cookie = encodeSessionCookie({ username: 'admin', role: 'admin', mustChangePassword: false })
  const [, signature] = cookie.split('.')
  const tamperedEncoded = Buffer.from(
    JSON.stringify({ username: 'admin', role: 'admin', mustChangePassword: false, exp: 9999999999 }),
  ).toString('base64url')
  assert.equal(decodeSessionCookie(`${tamperedEncoded}.${signature}`), null)
})

test('decodeSessionCookie rejects an expired session', () => {
  const nowSeconds = 1_700_000_000
  const cookie = encodeSessionCookie({ username: 'admin', role: 'admin', mustChangePassword: false }, nowSeconds)
  // Evaluate "now" far enough past the 12h expiry window baked into the cookie.
  const decoded = decodeSessionCookie(cookie, nowSeconds + 13 * 60 * 60)
  assert.equal(decoded, null)
})

test('decodeSessionCookie rejects a garbage/malformed cookie value without throwing', () => {
  assert.equal(decodeSessionCookie('not-a-real-cookie'), null)
  assert.equal(decodeSessionCookie(''), null)
  assert.equal(decodeSessionCookie('a.b'), null)
})
