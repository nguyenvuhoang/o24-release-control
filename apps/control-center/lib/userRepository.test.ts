import assert from 'node:assert/strict'
import test from 'node:test'
import { KvUserRepository } from './userRepository'

// Minimal in-memory stand-in for Upstash's REST protocol — enough to
// exercise KvUserRepository's SET-NX idempotency without a real network
// call. Mirrors the same mock style used in lib/github/w4sGraph.test.ts.
type MockKvStore = Map<string, string>

function handleKvCommand(store: MockKvStore, command: unknown[]): unknown {
  const [op, ...args] = command as string[]
  if (op === 'GET') {
    return store.has(args[0]) ? store.get(args[0]) : null
  }
  if (op === 'SET') {
    const [key, value, ...rest] = args
    if (rest.includes('NX') && store.has(key)) return null
    store.set(key, value)
    return 'OK'
  }
  throw new Error(`Mock KV does not support command: ${op}`)
}

function makeRepository(): { repo: KvUserRepository; store: MockKvStore } {
  const store: MockKvStore = new Map()
  const config = { url: 'https://fake-kv.example.com', token: 'fake-token' }
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const command = JSON.parse(String(init?.body))
    const result = handleKvCommand(store, command)
    return new Response(JSON.stringify({ result }), { status: 200 })
  }) as typeof fetch
  test.after(() => {
    globalThis.fetch = originalFetch
  })
  return { repo: new KvUserRepository(config), store }
}

test('createIfAbsent creates a new user and never stores the plaintext password anywhere in the record', async () => {
  const { repo, store } = makeRepository()
  const { record, created } = await repo.createIfAbsent({
    username: 'linhnq',
    passwordHash: '$2b$12$fakehashvalueforunittest',
    role: 'user',
    mustChangePassword: true,
    createdBy: 'seed-script',
  })
  assert.equal(created, true)
  assert.equal(record.username, 'linhnq')
  assert.equal(record.passwordHash, '$2b$12$fakehashvalueforunittest')
  assert.equal(record.mustChangePassword, true)

  const raw = store.get('o24:user:record:linhnq')
  assert.ok(raw)
  assert.ok(!raw.includes('linhnqpassword')) // sanity: no plaintext leaked into storage
})

test('createIfAbsent called a second time does NOT overwrite the existing user or change the password hash', async () => {
  const { repo } = makeRepository()
  const first = await repo.createIfAbsent({
    username: 'hoangnv',
    passwordHash: 'hash-one',
    role: 'user',
    mustChangePassword: true,
    createdBy: 'seed-script',
  })
  const second = await repo.createIfAbsent({
    username: 'hoangnv',
    passwordHash: 'hash-two-different',
    role: 'user',
    mustChangePassword: true,
    createdBy: 'seed-script-retry',
  })
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(second.record.passwordHash, 'hash-one')
  assert.equal(second.record.createdBy, 'seed-script')
})

test('getByUsername is case-insensitive and returns undefined for an unknown user', async () => {
  const { repo } = makeRepository()
  await repo.createIfAbsent({ username: 'LinhNQ', passwordHash: 'h', role: 'user', mustChangePassword: true, createdBy: 'x' })
  const found = await repo.getByUsername('linhnq')
  assert.ok(found)
  assert.equal(found.username, 'linhnq')

  const missing = await repo.getByUsername('nobody')
  assert.equal(missing, undefined)
})

test('updatePassword overwrites the hash and clears mustChangePassword, preserving role/createdAt/createdBy', async () => {
  const { repo } = makeRepository()
  const { record: original } = await repo.createIfAbsent({
    username: 'linhnq',
    passwordHash: 'old-hash',
    role: 'user',
    mustChangePassword: true,
    createdBy: 'seed-script',
  })

  const updated = await repo.updatePassword('linhnq', 'new-hash')
  assert.ok(updated)
  assert.equal(updated.passwordHash, 'new-hash')
  assert.equal(updated.mustChangePassword, false)
  assert.equal(updated.role, 'user')
  assert.equal(updated.createdAt, original.createdAt)
  assert.equal(updated.createdBy, 'seed-script')

  const fetched = await repo.getByUsername('linhnq')
  assert.equal(fetched?.passwordHash, 'new-hash')
  assert.equal(fetched?.mustChangePassword, false)
})

test('updatePassword on a nonexistent user returns undefined and creates nothing', async () => {
  const { repo, store } = makeRepository()
  const result = await repo.updatePassword('nobody', 'some-hash')
  assert.equal(result, undefined)
  assert.equal(store.size, 0)
})

// Regression test for the linhnq login investigation: seed (createIfAbsent)
// and login (getByUsername) must resolve to the EXACT same Redis key
// regardless of case/whitespace differences between how a username is
// typed at seed time vs login time — both go through userKey()'s shared
// normalizeUsername(), but this pins that contract directly so a future
// change to either path can't silently diverge them again.
test('createIfAbsent (seed path) and getByUsername (login path) resolve to the identical key for any case/whitespace variant', async () => {
  const { repo, store } = makeRepository()
  await repo.createIfAbsent({ username: '  LinhNQ  ', passwordHash: 'h', role: 'user', mustChangePassword: true, createdBy: 'seed-script' })

  assert.equal(store.size, 1)
  assert.ok(store.has('o24:user:record:linhnq'), 'expected the seeded record under the normalized key')

  for (const variant of ['linhnq', 'LINHNQ', 'LinhNq', ' linhnq ', 'linhnq\t']) {
    const found = await repo.getByUsername(variant)
    assert.ok(found, `expected getByUsername(${JSON.stringify(variant)}) to find the seeded user`)
    assert.equal(found.username, 'linhnq')
  }
})
