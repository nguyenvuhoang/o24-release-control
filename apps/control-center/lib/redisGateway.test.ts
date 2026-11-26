import assert from 'node:assert/strict'
import test from 'node:test'
import {
  gatewayCall,
  gatewayExecuteRedisCommand,
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
  const { restore, calls } = mockFetchSequence([() => okResponse('bar')])
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
    restore()
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

test('incr (non-idempotent) is NEVER retried even on a transient 500 — a blind retry could double-count', async () => {
  const { restore, callCount } = mockFetchSequence([() => new Response('', { status: 500 }), () => okResponse(2)])
  try {
    await assert.rejects(() => gatewayCall(CONFIG, 'incr', { key: 'foo' }))
    assert.equal(callCount(), 1, 'incr must fail fast on the first transient error, never consume the retry budget')
  } finally {
    restore()
  }
})

test('getdel (non-idempotent) is NEVER retried', async () => {
  const { restore, callCount } = mockFetchSequence([() => new Response('', { status: 502 })])
  try {
    await assert.rejects(() => gatewayCall(CONFIG, 'getdel', { key: 'foo' }))
    assert.equal(callCount(), 1)
  } finally {
    restore()
  }
})

// ---- gatewayExecuteRedisCommand: the raw-command translator kv.ts delegates to ----

test('GET/SET/DEL/INCR/EXISTS translate 1:1 to their gateway op', async () => {
  const { restore, calls } = mockFetchSequence([
    () => okResponse('hello'),
    () => okResponse('OK'),
    () => okResponse(1),
    () => okResponse(5),
    () => okResponse(1),
  ])
  try {
    assert.equal(await gatewayExecuteRedisCommand(CONFIG, ['GET', 'k']), 'hello')
    assert.equal(await gatewayExecuteRedisCommand(CONFIG, ['SET', 'k', 'v']), 'OK')
    assert.equal(await gatewayExecuteRedisCommand(CONFIG, ['DEL', 'k']), 1)
    assert.equal(await gatewayExecuteRedisCommand(CONFIG, ['INCR', 'k']), 5)
    assert.equal(await gatewayExecuteRedisCommand(CONFIG, ['EXISTS', 'k']), 1)
    assert.deepEqual(
      calls.map((body) => (body as { op: string }).op),
      ['get', 'set', 'del', 'incr', 'exists'],
    )
  } finally {
    restore()
  }
})

test('MGET fans out to one get per key, preserving order and nulls', async () => {
  const { restore, calls } = mockFetchSequence([() => okResponse('a'), () => okResponse(null), () => okResponse('c')])
  try {
    const result = await gatewayExecuteRedisCommand(CONFIG, ['MGET', 'k1', 'k2', 'k3'])
    assert.deepEqual(result, ['a', null, 'c'])
    assert.equal(calls.length, 3)
  } finally {
    restore()
  }
})

test('SET ... NX: the winning claim writes the value and returns OK', async () => {
  // sadd (claim, wins) -> set
  const { restore, calls } = mockFetchSequence([() => okResponse(1), () => okResponse('OK')])
  try {
    const result = await gatewayExecuteRedisCommand(CONFIG, ['SET', 'record:1', '{"a":1}', 'NX'])
    assert.equal(result, 'OK')
    assert.equal((calls[0] as { op: string; key: string }).op, 'sadd')
    assert.equal((calls[0] as { key: string }).key, 'record:1:__nx_claim')
    assert.equal((calls[1] as { op: string }).op, 'set')
  } finally {
    restore()
  }
})

test('SET ... NX: losing the claim polls GET until the winner value is visible, then returns null (never a false OK)', async () => {
  // sadd (claim, loses -> 0) -> get(null) -> get(value)
  const { restore, calls } = mockFetchSequence([() => okResponse(0), () => okResponse(null), () => okResponse('{"a":1}')])
  try {
    const result = await gatewayExecuteRedisCommand(CONFIG, ['SET', 'record:1', '{"a":1}', 'NX'])
    assert.equal(result, null)
    assert.equal(calls.length, 3)
  } finally {
    restore()
  }
})

test('SET ... NX PX: a successful claim also expires both the claim and the value key', async () => {
  const { restore, calls } = mockFetchSequence([() => okResponse(1), () => okResponse(1), () => okResponse('OK'), () => okResponse(1)])
  try {
    const result = await gatewayExecuteRedisCommand(CONFIG, ['SET', 'lock:sha1', '1', 'NX', 'PX', 60_000])
    assert.equal(result, 'OK')
    const ops = calls.map((body) => (body as { op: string }).op)
    assert.deepEqual(ops, ['sadd', 'expire', 'set', 'expire'])
    assert.equal((calls[1] as { seconds: number }).seconds, 60)
  } finally {
    restore()
  }
})

test('SET ... EX (no NX) is a plain set followed by expire — not treated as a uniqueness check', async () => {
  const { restore, calls } = mockFetchSequence([() => okResponse('OK'), () => okResponse(1)])
  try {
    const result = await gatewayExecuteRedisCommand(CONFIG, ['SET', 'cache:sha1', '{}', 'EX', 120])
    assert.equal(result, 'OK')
    assert.deepEqual(calls.map((body) => (body as { op: string }).op), ['set', 'expire'])
  } finally {
    restore()
  }
})

test('SADD/SREM/SMEMBERS/SCARD translate 1:1', async () => {
  const { restore } = mockFetchSequence([() => okResponse(1), () => okResponse(1), () => okResponse(['a', 'b']), () => okResponse(2)])
  try {
    assert.equal(await gatewayExecuteRedisCommand(CONFIG, ['SADD', 'set1', 'a']), 1)
    assert.equal(await gatewayExecuteRedisCommand(CONFIG, ['SREM', 'set1', 'a']), 1)
    assert.deepEqual(await gatewayExecuteRedisCommand(CONFIG, ['SMEMBERS', 'set1']), ['a', 'b'])
    assert.equal(await gatewayExecuteRedisCommand(CONFIG, ['SCARD', 'set1']), 2)
  } finally {
    restore()
  }
})

for (const command of [
  ['LPUSH', 'k', 'v'],
  ['LTRIM', 'k', 0, 10],
  ['LRANGE', 'k', 0, 10],
  ['ZADD', 'k', 1, 'm'],
  ['ZREM', 'k', 'm'],
  ['ZREVRANGE', 'k', 0, 10],
  ['ZRANGEBYSCORE', 'k', 0, 10],
]) {
  test(`${command[0]} has no Gateway v0.2.0 op — throws GatewayUnsupportedCommandError instead of faking it`, async () => {
    await assert.rejects(() => gatewayExecuteRedisCommand(CONFIG, command), GatewayUnsupportedCommandError)
  })
}

test('an unknown command throws GatewayUnsupportedCommandError, not a generic error', async () => {
  await assert.rejects(() => gatewayExecuteRedisCommand(CONFIG, ['HSET', 'k', 'f', 'v']), GatewayUnsupportedCommandError)
})

test('SET ... NX: if the claim is lost and the winner value never becomes visible, it throws rather than silently reporting null', async () => {
  const { restore } = mockFetchSequence([() => okResponse(0), ...Array(5).fill(() => okResponse(null))])
  try {
    await assert.rejects(() => gatewayExecuteRedisCommand(CONFIG, ['SET', 'record:1', '{}', 'NX']))
  } finally {
    restore()
  }
})
