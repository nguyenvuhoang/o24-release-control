import assert from 'node:assert/strict'
import test from 'node:test'
import { kvCommand, resolveKvConfig, RedisConfigError } from './kv'

const CONFIG = { provider: 'upstash' as const, url: 'https://fake-kv.example.com', token: 'fake-token' }

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const original: Record<string, string | undefined> = {}
  for (const key of Object.keys(vars)) original[key] = process.env[key]
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fn()
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// ---- Runtime provider selection (REDIS_PROVIDER) ----

test('REDIS_PROVIDER unset or "upstash" resolves the Upstash/Vercel KV REST config, unchanged from before this migration', () => {
  withEnv(
    { REDIS_PROVIDER: undefined, KV_REST_API_URL: 'https://kv.example.com', KV_REST_API_TOKEN: 'tok', REDIS_GATEWAY_URL: undefined },
    () => {
      const config = resolveKvConfig()
      assert.deepEqual(config, { provider: 'upstash', url: 'https://kv.example.com', token: 'tok' })
    },
  )
})

test('no KV/Upstash env configured and no REDIS_PROVIDER resolves to null (the existing "not configured" signal)', () => {
  withEnv(
    { REDIS_PROVIDER: undefined, KV_REST_API_URL: undefined, KV_REST_API_TOKEN: undefined, UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined },
    () => {
      assert.equal(resolveKvConfig(), null)
    },
  )
})

test('REDIS_PROVIDER=http with both gateway vars set resolves the http provider, never falls back to Upstash', () => {
  withEnv(
    { REDIS_PROVIDER: 'http', REDIS_GATEWAY_URL: 'https://redis-gateway.example.com', REDIS_GATEWAY_TOKEN: 'tok', KV_REST_API_URL: 'https://kv.example.com', KV_REST_API_TOKEN: 'kvtok' },
    () => {
      const config = resolveKvConfig()
      assert.equal(config?.provider, 'http')
      if (config?.provider === 'http') {
        assert.equal(config.gateway.url, 'https://redis-gateway.example.com')
        assert.equal(config.gateway.token, 'tok')
      }
    },
  )
})

test('REDIS_PROVIDER=http with missing gateway credentials throws RedisConfigError instead of silently falling back to in-memory storage', () => {
  withEnv({ REDIS_PROVIDER: 'http', REDIS_GATEWAY_URL: undefined, REDIS_GATEWAY_TOKEN: undefined }, () => {
    assert.throws(() => resolveKvConfig(), RedisConfigError)
  })
})

test('kvCommand with an http-provider config delegates to the Gateway (POST {url}/v1/redis), never the Upstash REST endpoint', async () => {
  const originalFetch = globalThis.fetch
  let capturedUrl: string | undefined
  globalThis.fetch = (async (url: unknown) => {
    capturedUrl = String(url)
    return new Response(JSON.stringify({ result: 'hello' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const result = await kvCommand({ provider: 'http', gateway: { url: 'https://redis-gateway.example.com', token: 'tok' } }, ['GET', 'k'])
    assert.equal(result, 'hello')
    assert.equal(capturedUrl, 'https://redis-gateway.example.com/v1/redis')
  } finally {
    globalThis.fetch = originalFetch
  }
})

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
