import assert from 'node:assert/strict'
import test from 'node:test'
import { kvCommand } from './kv'

const CONFIG = { url: 'https://fake-kv.example.com', token: 'fake-token' }

type FetchHandler = () => Response | Promise<Response> | never

function mockFetchSequence(handlers: FetchHandler[]) {
  const originalFetch = globalThis.fetch
  let call = 0
  globalThis.fetch = (async () => {
    const handler = handlers[call]
    call += 1
    if (!handler) throw new Error(`Unexpected extra fetch call #${call}`)
    return handler()
  }) as typeof fetch
  return { restore: () => { globalThis.fetch = originalFetch }, callCount: () => call }
}

function okResponse(result: unknown): Response {
  return new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } })
}

// This is the ONE shared chokepoint behind audit, release snapshots, build
// pointers, snapshot jobs and non-admin login — these tests cover the exact
// hardening (timeout + bounded retry) that fixes the simultaneous-failure
// pattern observed in production.

test('a KV command that 500s once then succeeds is retried automatically', async () => {
  const { restore, callCount } = mockFetchSequence([() => new Response('', { status: 500 }), () => okResponse('OK')])
  try {
    const result = await kvCommand(CONFIG, ['SET', 'k', 'v', 'NX'])
    assert.equal(result, 'OK')
    assert.equal(callCount(), 2)
  } finally {
    restore()
  }
})

test('a KV command that fails at the network level then succeeds recovers automatically', async () => {
  const { restore, callCount } = mockFetchSequence([
    () => {
      throw new TypeError('fetch failed')
    },
    () => okResponse('OK'),
  ])
  try {
    const result = await kvCommand(CONFIG, ['GET', 'k'])
    assert.equal(result, 'OK')
    assert.equal(callCount(), 2)
  } finally {
    restore()
  }
})

test('a KV command that keeps failing past the retry budget throws (never hangs forever)', async () => {
  const { restore, callCount } = mockFetchSequence([
    () => new Response('', { status: 500 }),
    () => new Response('', { status: 502 }),
    () => new Response('', { status: 503 }),
  ])
  try {
    await assert.rejects(() => kvCommand(CONFIG, ['GET', 'k']))
    assert.equal(callCount(), 3)
  } finally {
    restore()
  }
})

test('a 4xx (bad command/auth) is NEVER retried — retrying it can never change the outcome', async () => {
  const { restore, callCount } = mockFetchSequence([
    () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } }),
  ])
  try {
    await assert.rejects(() => kvCommand(CONFIG, ['GET', 'k']))
    assert.equal(callCount(), 1, 'a 4xx must fail fast, not consume the retry budget')
  } finally {
    restore()
  }
})
