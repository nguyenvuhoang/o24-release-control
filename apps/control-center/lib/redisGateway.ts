// Centralized HTTP adapter for the self-hosted Redis Gateway
// (POST {url}/v1/redis, body {op, ...params} -> {result}) — the replacement
// for Upstash once REDIS_PROVIDER=http. kv.ts's kvCommand() delegates every
// Redis command here via gatewayExecuteRedisCommand() so repositories never
// need to know which provider is behind them.
//
// Gateway v0.2.0's documented contract is exactly these 14 ops: get, set,
// del, exists, ttl, pttl, expire, getdel, incr, rateLimit, sadd, srem,
// smembers, scard, compareAndDelete. There is no documented "set if not
// exists" or ordered/list op, so those raw Redis commands are either
// emulated from the documented ops (never via an unsafe GET/SET race — see
// setIfAbsent below) or rejected with GatewayUnsupportedCommandError. See
// docs/REDIS_GATEWAY.md for the exact contracts a future Gateway version
// would need to add to remove the remaining emulations.

export type GatewayConfig = {
  url: string
  token: string
  cfAccessClientId?: string
  cfAccessClientSecret?: string
}

export function resolveGatewayConfig(): GatewayConfig | null {
  const url = process.env.REDIS_GATEWAY_URL
  const token = process.env.REDIS_GATEWAY_TOKEN
  if (!url || !token) return null
  return {
    url,
    token,
    cfAccessClientId: process.env.CF_ACCESS_CLIENT_ID || undefined,
    cfAccessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET || undefined,
  }
}

// Bounded per-attempt timeout, same rationale as kv.ts's DEFAULT_TIMEOUT_MS —
// this is now an equally shared chokepoint once REDIS_PROVIDER=http.
const DEFAULT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.REDIS_GATEWAY_TIMEOUT_MS ?? process.env.KV_REQUEST_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 5_000
})()
const MAX_RETRIES = 2 // up to 3 total attempts
const BASE_RETRY_DELAY_MS = 150
const MAX_RETRY_DELAY_MS = 1_500

export type GatewayOp =
  | 'get'
  | 'set'
  | 'del'
  | 'exists'
  | 'ttl'
  | 'pttl'
  | 'expire'
  | 'getdel'
  | 'incr'
  | 'rateLimit'
  | 'sadd'
  | 'srem'
  | 'smembers'
  | 'scard'
  | 'compareAndDelete'

export class GatewayCommandError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly op: GatewayOp | 'set',
  ) {
    super(message)
    this.name = 'GatewayCommandError'
  }
}

/**
 * A raw Redis command (e.g. ZADD, LPUSH) that Gateway v0.2.0 has no
 * operation for. Thrown instead of silently emulating it unsafely or
 * asserting the method exists — callers get a controlled error, never a
 * false success. See docs/REDIS_GATEWAY.md for the exact contract the
 * Gateway would need to add.
 */
export class GatewayUnsupportedCommandError extends Error {
  constructor(
    public readonly command: string,
    hint: string,
  ) {
    super(`Redis Gateway v0.2.0 has no operation for "${command}" — ${hint} See docs/REDIS_GATEWAY.md.`)
    this.name = 'GatewayUnsupportedCommandError'
  }
}

// Ops whose observable result can change if replayed — even when the first
// attempt actually succeeded server-side before the response was lost (a
// double increment, a getdel that already consumed the value, a rate-limit
// window counted twice, a compare that no longer matches after the first
// attempt already deleted it). Every other documented op reaches the same
// end state no matter how many times it's applied, so only these are
// excluded from the bounded transient-retry in gatewayCall — "never retry a
// non-idempotent operation automatically".
const NON_IDEMPOTENT_OPS = new Set<GatewayOp>(['incr', 'getdel', 'rateLimit', 'compareAndDelete'])

function isTransient(error: unknown): boolean {
  if (error instanceof GatewayCommandError) return error.status === null || error.status >= 500
  return true // network/timeout errors never reach GatewayCommandError construction
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function gatewayEndpoint(config: GatewayConfig): string {
  return `${config.url.replace(/\/+$/, '')}/v1/redis`
}

async function gatewayCallOnce(config: GatewayConfig, op: GatewayOp, params: Record<string, unknown>): Promise<unknown> {
  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(gatewayEndpoint(config), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
        ...(config.cfAccessClientId ? { 'CF-Access-Client-Id': config.cfAccessClientId } : {}),
        ...(config.cfAccessClientSecret ? { 'CF-Access-Client-Secret': config.cfAccessClientSecret } : {}),
      },
      body: JSON.stringify({ op, ...params }),
      cache: 'no-store',
      signal: controller.signal,
    })
  } catch (networkError) {
    const isTimeout = networkError instanceof Error && networkError.name === 'AbortError'
    const message = networkError instanceof Error ? networkError.message : 'Unknown network error'
    throw new GatewayCommandError(
      isTimeout ? `Redis Gateway request timed out after ${DEFAULT_TIMEOUT_MS}ms` : `Redis Gateway request failed: ${message}`,
      null,
      op,
    )
  } finally {
    clearTimeout(timeoutHandle)
  }

  const body = (await response.json().catch(() => null)) as { result?: unknown; error?: string } | null
  if (!response.ok) {
    throw new GatewayCommandError(`Redis Gateway op "${op}" failed (${response.status}): ${body?.error ?? response.statusText}`, response.status, op)
  }
  return body?.result
}

/** Bounded retry (3 attempts total) with backoff + jitter for transient failures — mirrors kv.ts's kvCommand. */
export async function gatewayCall(config: GatewayConfig, op: GatewayOp, params: Record<string, unknown> = {}): Promise<unknown> {
  let attempt = 0
  for (;;) {
    try {
      return await gatewayCallOnce(config, op, params)
    } catch (error) {
      const retryable = attempt < MAX_RETRIES && !NON_IDEMPOTENT_OPS.has(op) && isTransient(error)
      if (!retryable) throw error
      const base = Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS)
      await sleep(Math.round(base * (0.5 + Math.random())))
      attempt += 1
    }
  }
}

// ---- Typed per-op helpers — the documented Gateway v0.2.0 contract ----

export async function gatewayGet(config: GatewayConfig, key: string): Promise<string | null> {
  const result = await gatewayCall(config, 'get', { key })
  return typeof result === 'string' ? result : null
}

export async function gatewaySet(config: GatewayConfig, key: string, value: string): Promise<void> {
  await gatewayCall(config, 'set', { key, value })
}

export async function gatewayDel(config: GatewayConfig, key: string): Promise<number> {
  return Number(await gatewayCall(config, 'del', { key })) || 0
}

export async function gatewayExists(config: GatewayConfig, key: string): Promise<number> {
  return Number(await gatewayCall(config, 'exists', { key })) || 0
}

export async function gatewayTtl(config: GatewayConfig, key: string): Promise<number> {
  return Number(await gatewayCall(config, 'ttl', { key }))
}

export async function gatewayPttl(config: GatewayConfig, key: string): Promise<number> {
  return Number(await gatewayCall(config, 'pttl', { key }))
}

export async function gatewayExpire(config: GatewayConfig, key: string, seconds: number): Promise<number> {
  return Number(await gatewayCall(config, 'expire', { key, seconds })) || 0
}

export async function gatewayGetDel(config: GatewayConfig, key: string): Promise<string | null> {
  const result = await gatewayCall(config, 'getdel', { key })
  return typeof result === 'string' ? result : null
}

export async function gatewayIncr(config: GatewayConfig, key: string): Promise<number> {
  return Number(await gatewayCall(config, 'incr', { key }))
}

export async function gatewaySadd(config: GatewayConfig, key: string, member: string): Promise<number> {
  return Number(await gatewayCall(config, 'sadd', { key, member })) || 0
}

export async function gatewaySrem(config: GatewayConfig, key: string, member: string): Promise<number> {
  return Number(await gatewayCall(config, 'srem', { key, member })) || 0
}

export async function gatewaySmembers(config: GatewayConfig, key: string): Promise<string[]> {
  const result = await gatewayCall(config, 'smembers', { key })
  return Array.isArray(result) ? result.filter((item): item is string => typeof item === 'string') : []
}

export async function gatewayScard(config: GatewayConfig, key: string): Promise<number> {
  return Number(await gatewayCall(config, 'scard', { key })) || 0
}

export async function gatewayCompareAndDelete(config: GatewayConfig, key: string, expectedValue: string): Promise<boolean> {
  const result = await gatewayCall(config, 'compareAndDelete', { key, value: expectedValue })
  return result === true || result === 1
}

export type RateLimitResult = { allowed: boolean; remaining?: number }

export async function gatewayRateLimit(config: GatewayConfig, key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const result = (await gatewayCall(config, 'rateLimit', { key, limit, windowSeconds })) as { allowed?: boolean; remaining?: number } | null
  return { allowed: result?.allowed !== false, remaining: result?.remaining }
}

// ---- Raw Redis command translator — what kv.ts's kvCommand() calls under
// REDIS_PROVIDER=http, so every existing repository keeps issuing the same
// command arrays it already does for Upstash. ----

// Bounded wait for the race-winner's value to become visible after this
// instance lost a setIfAbsent claim (see below) — short because this sits
// on the hot path of audit/release/user-create append, not a background
// fetch. ~1.55s worst case, only ever hit when two instances genuinely
// race the same id at the same moment.
const SETNX_POLL_DELAYS_MS = [50, 100, 200, 400, 800]

/**
 * Emulates Redis `SET key value NX [EX sec | PX ms]` using only documented
 * ops. The uniqueness decision itself is made by `sadd` on a claim key —
 * SADD is atomic, so two concurrent callers can never both believe they
 * created the record (never an unsafe GET/SET race). The claim's winner
 * then writes the real value; a loser polls GET briefly for that write to
 * land (it may not be visible the instant the claim resolves) before
 * reporting "not created by us" — exactly like Upstash's native SET NX,
 * callers branch on `result === 'OK'`.
 */
async function setIfAbsent(config: GatewayConfig, key: string, value: string, ttlSeconds?: number): Promise<'OK' | null> {
  const claimKey = `${key}:__nx_claim`
  const claimed = await gatewaySadd(config, claimKey, '1')
  if (claimed > 0) {
    if (ttlSeconds) await gatewayExpire(config, claimKey, ttlSeconds)
    await gatewaySet(config, key, value)
    if (ttlSeconds) await gatewayExpire(config, key, ttlSeconds)
    return 'OK'
  }

  for (const delayMs of SETNX_POLL_DELAYS_MS) {
    await sleep(delayMs)
    const existing = await gatewayGet(config, key)
    if (existing !== null) return null
  }
  throw new GatewayCommandError(`SET ${key} NX: lost the creation race via claim key but its value never became visible`, null, 'set')
}

function parseSetArgs(args: (string | number)[]): { nx: boolean; ttlSeconds: number | undefined } {
  let nx = false
  let ttlSeconds: number | undefined
  for (let i = 2; i < args.length; i += 1) {
    const token = String(args[i]).toUpperCase()
    if (token === 'NX') nx = true
    else if (token === 'EX') {
      ttlSeconds = Number(args[i + 1])
      i += 1
    } else if (token === 'PX') {
      ttlSeconds = Math.max(1, Math.ceil(Number(args[i + 1]) / 1000))
      i += 1
    }
  }
  return { nx, ttlSeconds }
}

async function gatewaySetCommand(config: GatewayConfig, args: (string | number)[]): Promise<'OK' | null> {
  const key = String(args[0])
  const value = String(args[1])
  const { nx, ttlSeconds } = parseSetArgs(args)

  if (!nx) {
    await gatewaySet(config, key, value)
    if (ttlSeconds) await gatewayExpire(config, key, ttlSeconds)
    return 'OK'
  }
  return setIfAbsent(config, key, value, ttlSeconds)
}

const LIST_OP_HINT = 'a bounded recent-items index needs native list ops (lpush/ltrim/lrange) on the Gateway'
const ZSET_OP_HINT = 'an ordered/paginated index needs native sorted-set ops (zadd/zrevrange/zrangebyscore/zrem) on the Gateway'

/** Routes one raw Redis command array (the same shape every repository already builds for Upstash) to the Gateway's op set. */
export async function gatewayExecuteRedisCommand(config: GatewayConfig, command: (string | number)[]): Promise<unknown> {
  const [verbRaw, ...args] = command
  const verb = String(verbRaw).toUpperCase()
  switch (verb) {
    case 'GET':
      return gatewayGet(config, String(args[0]))
    case 'SET':
      return gatewaySetCommand(config, args)
    case 'DEL':
      return gatewayDel(config, String(args[0]))
    case 'EXISTS':
      return gatewayExists(config, String(args[0]))
    case 'TTL':
      return gatewayTtl(config, String(args[0]))
    case 'PTTL':
      return gatewayPttl(config, String(args[0]))
    case 'EXPIRE':
      return gatewayExpire(config, String(args[0]), Number(args[1]))
    case 'GETDEL':
      return gatewayGetDel(config, String(args[0]))
    case 'INCR':
      return gatewayIncr(config, String(args[0]))
    case 'MGET':
      // Not atomic, but MGET's only job here is a batch-read optimization —
      // the individual GETs it's built from don't need to be atomic with
      // each other, just correct.
      return Promise.all(args.map((key) => gatewayGet(config, String(key))))
    case 'SADD':
      return gatewaySadd(config, String(args[0]), String(args[1]))
    case 'SREM':
      return gatewaySrem(config, String(args[0]), String(args[1]))
    case 'SMEMBERS':
      return gatewaySmembers(config, String(args[0]))
    case 'SCARD':
      return gatewayScard(config, String(args[0]))
    case 'LPUSH':
    case 'LTRIM':
    case 'LRANGE':
      throw new GatewayUnsupportedCommandError(verb, LIST_OP_HINT)
    case 'ZADD':
    case 'ZREM':
    case 'ZREVRANGE':
    case 'ZRANGEBYSCORE':
      throw new GatewayUnsupportedCommandError(verb, ZSET_OP_HINT)
    default:
      throw new GatewayUnsupportedCommandError(verb, 'no documented Gateway v0.2.0 operation covers this command')
  }
}
