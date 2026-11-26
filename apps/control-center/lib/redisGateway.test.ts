import assert from 'node:assert/strict'
import test from 'node:test'
import {
  gatewayCall,
  gatewayExecuteRedisCommand,
  gatewaySet,
  GatewayCommandError,
  GatewayUnsupportedCommandError,
  type GatewayConfig,
} from './redisGateway'

const CONFIG: GatewayConfig = { url: 'https://fake-gateway.example.com', token: 'fake-token' }

type FetchHandler = (body: unknown) => Response | Promise<Response> | never

function mockFetchSequence(handlers: FetchHandler[]) {
  const originalFetch = globalThis.fetch
  const calls: unknown[] = []
  let call = 0
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push(body)
    const handler = handlers[call]
    call += 1
    if (!handler) throw new Error(`Unexpected extra fetch call #${call}`)
    return handler(body)
  }) as typeof fetch
  return {
    restore: () => {
      globalThis.fetch = originalFetch
    },
    callCount: () => call,
    calls,
  }
}

function okResponse(result: unknown): Response {
  return new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } })
}

// ---- gatewayCall: request shape, auth headers, retry policy ----

test('gatewayCall posts {op,...params} to {url}/v1/redis with bearer auth and no-store', async () => {
  const originalFetch = globalThis.fetch
  let capturedUrl: string | undefined
  let capturedInit: RequestInit | undefined
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    capturedUrl = String(url)
    capturedInit = init
    return okResponse('bar')
  }) as typeof fetch
  try {
    const result = await gatewayCall(CONFIG, 'get', { key: 'foo' })
    assert.equal(result, 'bar')
    assert.equal(capturedUrl, 'https://fake-gateway.example.com/v1/redis')
    assert.equal(capturedInit?.cache, 'no-store')
    const headers = capturedInit?.headers as Record<string, string>
    assert.equal(headers.Authorization, 'Bearer fake-token')
    assert.equal(JSON.parse(String(capturedInit?.body)).op, 'get')
    assert.equal(JSON.parse(String(capturedInit?.body)).key, 'foo')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('CF Access headers are included only when configured', async () => {
  const originalFetch = globalThis.fetch
  let headers: Record<string, string> = {}
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    headers = init?.headers as Record<string, string>
    return okResponse(null)
  }) as typeof fetch
  try {
    await gatewayCall(CONFIG, 'get', { key: 'foo' })
    assert.equal('CF-Access-Client-Id' in headers, false)

    await gatewayCall({ ...CONFIG, cfAccessClientId: 'cid', cfAccessClientSecret: 'csecret' }, 'get', { key: 'foo' })
    assert.equal(headers['CF-Access-Client-Id'], 'cid')
    assert.equal(headers['CF-Access-Client-Secret'], 'csecret')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a transient 500 on an idempotent op (get) is retried automatically', async () => {
  const { restore, callCount } = mockFetchSequence([() => new Response('', { status: 500 }), () => okResponse('bar')])
  try {
    const result = await gatewayCall(CONFIG, 'get', { key: 'foo' })
    assert.equal(result, 'bar')
    assert.equal(callCount(), 2)
  } finally {
    restore()
  }
})

test('a 4xx is never retried', async () => {
  const { restore, callCount } = mockFetchSequence([
    () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } }),
  ])
  try {
    await assert.rejects(() => gatewayCall(CONFIG, 'get', { key: 'foo' }))
    assert.equal(callCount(), 1)
  } finally {
    restore()
  }
})

for (const op of ['incr', 'getdel', 'rateLimit', 'compareAndDelete', 'lpush'] as const) {
  test(`${op} (non-idempotent) is NEVER retried, even on a transient 500 — a blind retry could change the outcome`, async () => {
    const { restore, callCount } = mockFetchSequence([() => new Response('', { status: 500 })])
    try {
      await assert.rejects(() => gatewayCall(CONFIG, op, { key: 'foo' }))
      assert.equal(callCount(), 1, `${op} must fail fast on the first transient error, never consume the retry budget`)
    } finally {
      restore()
    }
  })
}

test('a network failure during a write op propagates a GatewayCommandError, never a silent success', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed')
  }) as typeof fetch
  try {
    await assert.rejects(() => gatewaySet(CONFIG, 'k', 'v'), GatewayCommandError)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ---- Native conditional SET: one request, no claim/emulation ----

test('SET (no flags) is a single plain "set" request', async () => {
  const { restore, calls, callCount } = mockFetchSequence([() => okResponse('OK')])
  try {
    const result = await gatewayExecuteRedisCommand(CONFIG, ['SET', 'k', 'v'])
    assert.equal(result, 'OK')
    assert.equal(callCount(), 1, 'a plain SET must be exactly one Gateway request')
    assert.deepEqual(calls[0], { op: 'set', key: 'k', value: 'v' })
  } finally {
    restore()
  }
})

test('SET ... NX succeeding is a single atomic "set" request with nx:true — no claim key, no second request', async () => {
  const { restore, calls, callCount } = mockFetchSequence([() => okResponse('OK')])
  try {
    const result = await gatewayExecuteRedisCommand(CONFIG, ['SET', 'record:1', '{"a":1}', 'NX'])
    assert.equal(result, 'OK')
    assert.equal(callCount(), 1, 'SET NX must be exactly one Gateway request — never sadd-then-set')
    assert.deepEqual(calls[0], { op: 'set', key: 'record:1', value: '{"a":1}', nx: true })
  } finally {
    restore()
  }
})

test('SET ... NX on an already-existing key: the Gateway reports the condition failed (null) in the SAME single request — no polling, no second read', async () => {
  const { restore, callCount } = mockFetchSequence([() => okResponse(null)])
  try {
    const result = await gatewayExecuteRedisCommand(CONFIG, ['SET', 'record:1', '{"a":1}', 'NX'])
    assert.equal(result, null)
    assert.equal(callCount(), 1, 'a failed NX condition must not trigger any follow-up request from the adapter')
  } finally {
    restore()
  }
})

test('two "concurrent" SET NX calls against the same key: only the Gateway (not the adapter) arbitrates who wins — each call is independent and single-request', async () => {
  // Simulates the Gateway's own atomic arbitration: first caller's single
  // request wins (OK), second caller's single request loses (null) — the
  // adapter never coordinates this itself (no local claim/lock state).
  const { restore } = mockFetchSequence([() => okResponse('OK'), () => okResponse(null)])
  try {
    const [first, second] = await Promise.all([
      gatewayExecuteRedisCommand(CONFIG, ['SET', 'record:dup', 'v', 'NX']),
      gatewayExecuteRedisCommand(CONFIG, ['SET', 'record:dup', 'v', 'NX']),
    ])
    assert.deepEqual(new Set([first, second]), new Set(['OK', null]))
  } finally {
    restore()
  }
})

test('SET ... NX EX seconds sends nx+ex in one request', async () => {
  const { restore, calls } = mockFetchSequence([() => okResponse('OK')])
  try {
    await gatewayExecuteRedisCommand(CONFIG, ['SET', 'k', 'v', 'NX', 'EX', 120])
    assert.deepEqual(calls[0], { op: 'set', key: 'k', value: 'v', nx: true, ex: 120 })
  } finally {
    restore()
  }
})

test('SET ... NX PX milliseconds sends nx+px (milliseconds, not converted to seconds) in one request', async () => {
  const { restore, calls } = mockFetchSequence([() => okResponse('OK')])
  try {
    await gatewayExecuteRedisCommand(CONFIG, ['SET', 'lock:sha1', '1', 'NX', 'PX', 60_000])
    assert.deepEqual(calls[0], { op: 'set', key: 'lock:sha1', value: '1', nx: true, px: 60_000 })
  } finally {
    restore()
  }
})

test('SET ... XX sends xx:true', async () => {
  const { restore, calls } = mockFetchSequence([() => okResponse('OK')])
  try {
    await gatewayExecuteRedisCommand(CONFIG, ['SET', 'k', 'v', 'XX'])
    assert.deepEqual(calls[0], { op: 'set', key: 'k', value: 'v', xx: true })
  } finally {
    restore()
  }
})

test('gatewaySet treats both "OK" and boolean true as success, anything else as a failed condition', async () => {
  const { restore } = mockFetchSequence([() => okResponse('OK'), () => okResponse(true), () => okResponse(null), () => okResponse(false)])
  try {
    assert.equal(await gatewaySet(CONFIG, 'k', 'v'), 'OK')
    assert.equal(await gatewaySet(CONFIG, 'k', 'v'), 'OK')
    assert.equal(await gatewaySet(CONFIG, 'k', 'v', { nx: true }), null)
    assert.equal(await gatewaySet(CONFIG, 'k', 'v', { nx: true }), null)
  } finally {
    restore()
  }
})

// ---- GET/DEL/EXISTS/INCR etc: 1:1 translation ----

test('GET/DEL/INCR/EXISTS translate 1:1 to their gateway op', async () => {
  const { restore, calls } = mockFetchSequence([() => okResponse('hello'), () => okResponse(1), () => okResponse(5), () => okResponse(1)])
  try {
    assert.equal(await gatewayExecuteRedisCommand(CONFIG, ['GET', 'k']), 'hello')
    assert.equal(await gatewayExecuteRedisCommand(CONFIG, ['DEL', 'k']), 1)
    assert.equal(await gatewayExecuteRedisCommand(CONFIG, ['INCR', 'k']), 5)
    assert.equal(await gatewayExecuteRedisCommand(CONFIG, ['EXISTS', 'k']), 1)
    assert.deepEqual(
      calls.map((body) => (body as { op: string }).op),
      ['get', 'del', 'incr', 'exists'],
    )
  } finally {
    restore()
  }
})

// ---- Native list ops ----

test('MGET is a single native "mget" request, not N gets', async () => {
  const { restore, calls, callCount } = mockFetchSequence([() => okResponse(['a', null, 'c'])])
  try {
    const result = await gatewayExecuteRedisCommand(CONFIG, ['MGET', 'k1', 'k2', 'k3'])
    assert.deepEqual(result, ['a', null, 'c'])
    assert.equal(callCount(), 1, 'MGET must be one Gateway request, not a per-key fan-out')
    assert.deepEqual(calls[0], { op: 'mget', keys: ['k1', 'k2', 'k3'] })
  } finally {
    restore()
  }
})

test('MGET preserves order and nulls for missing keys', async () => {
  const { restore } = mockFetchSequence([() => okResponse([null, 'b', null])])
  try {
    const result = await gatewayExecuteRedisCommand(CONFIG, ['MGET', 'k1', 'k2', 'k3'])
    assert.deepEqual(result, [null, 'b', null])
  } finally {
    restore()
  }
})

test('LPUSH translates to native "lpush" and returns the new length', async () => {
  const { restore, calls } = mockFetchSequence([() => okResponse(3)])
  try {
    const result = await gatewayExecuteRedisCommand(CONFIG, ['LPUSH', 'idx', 'id-1'])
    assert.equal(result, 3)
    assert.deepEqual(calls[0], { op: 'lpush', key: 'idx', value: 'id-1' })
  } finally {
    restore()
  }
})

test('LTRIM translates to native "ltrim" with inclusive start/stop', async () => {
  const { restore, calls } = mockFetchSequence([() => okResponse('OK')])
  try {
    await gatewayExecuteRedisCommand(CONFIG, ['LTRIM', 'idx', 0, 999])
    assert.deepEqual(calls[0], { op: 'ltrim', key: 'idx', start: 0, stop: 999 })
  } finally {
    restore()
  }
})

test('LRANGE translates to native "lrange" and returns the ordered list', async () => {
  const { restore, calls } = mockFetchSequence([() => okResponse(['id-3', 'id-2', 'id-1'])])
  try {
    const result = await gatewayExecuteRedisCommand(CONFIG, ['LRANGE', 'idx', 0, 29])
    assert.deepEqual(result, ['id-3', 'id-2', 'id-1'])
    assert.deepEqual(calls[0], { op: 'lrange', key: 'idx', start: 0, stop: 29 })
  } finally {
    restore()
  }
})

// ---- Native sorted-set ops ----

test('ZADD translates to native "zadd" with numeric score', async () => {
  const { restore, calls } = mockFetchSequence([() => okResponse(1)])
  try {
    const result = await gatewayExecuteRedisCommand(CONFIG, ['ZADD', 'zset', 1732564000000, 'release:1'])
    assert.equal(result, 1)
    assert.deepEqual(calls[0], { op: 'zadd', key: 'zset', score: 1732564000000, member: 'release:1' })
  } finally {
    restore()
  }
})

test('ZREM translates to native "zrem"', async () => {
  const { restore, calls } = mockFetchSequence([() => okResponse(1)])
  try {
    const result = await gatewayExecuteRedisCommand(CONFIG, ['ZREM', 'zset', 'release:1'])
    assert.equal(result, 1)
    assert.deepEqual(calls[0], { op: 'zrem', key: 'zset', member: 'release:1' })
  } finally {
    restore()
  }
})

test('ZREVRANGE translates to native "zrevrange" (highest score first)', async () => {
  const { restore, calls } = mockFetchSequence([() => okResponse(['release:3', 'release:2', 'release:1'])])
  try {
    const result = await gatewayExecuteRedisCommand(CONFIG, ['ZREVRANGE', 'zset', 0, 49])
    assert.deepEqual(result, ['release:3', 'release:2', 'release:1'])
    assert.deepEqual(calls[0], { op: 'zrevrange', key: 'zset', start: 0, stop: 49 })
  } finally {
    restore()
  }
})

test('ZRANGEBYSCORE without LIMIT sends only key/min/max', async () => {
  const { restore, calls } = mockFetchSequence([() => okResponse(['job:1'])])
  try {
    await gatewayExecuteRedisCommand(CONFIG, ['ZRANGEBYSCORE', 'zset', '-inf', 1732564000000])
    assert.deepEqual(calls[0], { op: 'zrangebyscore', key: 'zset', min: '-inf', max: '1732564000000' })
  } finally {
    restore()
  }
})

test('ZRANGEBYSCORE with LIMIT offset count parses the optional clause', async () => {
  const { restore, calls } = mockFetchSequence([() => okResponse(['job:1', 'job:2'])])
  try {
    const result = await gatewayExecuteRedisCommand(CONFIG, ['ZRANGEBYSCORE', 'zset', '-inf', 1732564000000, 'LIMIT', 0, 20])
    assert.deepEqual(result, ['job:1', 'job:2'])
    assert.deepEqual(calls[0], { op: 'zrangebyscore', key: 'zset', min: '-inf', max: '1732564000000', offset: 0, count: 20 })
  } finally {
    restore()
  }
})

// ---- Unknown command: still a controlled error ----

test('an unknown command throws GatewayUnsupportedCommandError, not a generic error', async () => {
  await assert.rejects(() => gatewayExecuteRedisCommand(CONFIG, ['HSET', 'k', 'f', 'v']), GatewayUnsupportedCommandError)
})
