// Centralized HTTP adapter for the self-hosted Redis Gateway
// (POST {url}/v1/redis, body {op, ...params} -> {result}) — the replacement
// for Upstash once REDIS_PROVIDER=http. kv.ts's kvCommand() delegates every
// Redis command here via gatewayExecuteRedisCommand() so repositories never
// need to know which provider is behind them.
//
// Targets Gateway v0.3.0, which adds native conditional SET (nx/xx/ex/px)
// and native list/sorted-set ops (mget, lpush, ltrim, lrange, zadd,
// zrevrange, zrangebyscore, zrem) on top of v0.2.0's get/set/del/exists/
// ttl/pttl/expire/getdel/incr/rateLimit/sadd/srem/smembers/scard/
// compareAndDelete. Every op here is translated 1:1 to a single Gateway
// request — no client-side emulation of atomicity (no claim keys, no
// GET/SET races, no multi-request fan-out standing in for a data
// structure). See docs/REDIS_GATEWAY.md for the exact request/response
// contract this file assumes for every op, and its "2026-11-26 Vercel
// transport incident" note for why gatewayCallOnce below validates the raw
// transport response (redirect/content-type/JSON envelope) instead of just
// trusting response.ok, and why the request's timeout now provably covers
// body consumption, not just connecting.
import { resolveGatewayTransport, sendGatewayRequest, type GatewayRawResponse } from './redisGatewayTransport'

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
/** Exported so the admin transport diagnostic endpoint measures against the SAME configured budget production calls actually use, never a different one. */
export const GATEWAY_REQUEST_TIMEOUT_MS = DEFAULT_TIMEOUT_MS
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
  | 'mget'
  | 'lpush'
  | 'ltrim'
  | 'lrange'
  | 'zadd'
  | 'zrevrange'
  | 'zrangebyscore'
  | 'zrem'

export class GatewayCommandError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly op: GatewayOp,
  ) {
    super(message)
    this.name = 'GatewayCommandError'
  }
}

/**
 * A raw Redis command that the configured Gateway version has no operation
 * for. Thrown instead of silently emulating it unsafely or asserting the
 * method exists — callers get a controlled error, never a false success.
 * See docs/REDIS_GATEWAY.md.
 */
export class GatewayUnsupportedCommandError extends Error {
  constructor(
    public readonly command: string,
    hint: string,
  ) {
    super(`The configured Redis Gateway has no operation for "${command}" — ${hint} See docs/REDIS_GATEWAY.md.`)
    this.name = 'GatewayUnsupportedCommandError'
  }
}

// Ops whose observable result can change if replayed — even when the first
// attempt actually succeeded server-side before the response was lost (a
// double increment, a getdel that already consumed the value, a rate-limit
// window counted twice, a compare that no longer matches after the first
// attempt already deleted it, a list push that would append twice). Every
// other documented op reaches the same end state no matter how many times
// it's applied — including conditional `set`: its id/value pairs are always
// deterministic here, so a retried SET NX either re-confirms the same write
// or correctly discovers it already happened — so only these are excluded
// from the bounded transient-retry in gatewayCall — "never retry a
// non-idempotent operation automatically".
const NON_IDEMPOTENT_OPS = new Set<GatewayOp>(['incr', 'getdel', 'rateLimit', 'compareAndDelete', 'lpush'])

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

function gatewayHeaders(config: GatewayConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.token}`,
    ...(config.cfAccessClientId ? { 'CF-Access-Client-Id': config.cfAccessClientId } : {}),
    ...(config.cfAccessClientSecret ? { 'CF-Access-Client-Secret': config.cfAccessClientSecret } : {}),
  }
}

// Pulls a POSIX/libuv error code (ECONNRESET, ETIMEDOUT, ENOTFOUND, ...) off
// a thrown network error without ever touching its message/headers/body —
// genuinely useful for diagnosing a transport issue, and never sensitive
// (unlike a header value or response body, which might echo back
// credentials or Redis data and must never be logged).
function networkErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const withCode = error as { code?: unknown; cause?: { code?: unknown } }
  const code = withCode.code ?? withCode.cause?.code
  return typeof code === 'string' ? code : undefined
}

async function gatewayCallOnce(config: GatewayConfig, op: GatewayOp, params: Record<string, unknown>): Promise<unknown> {
  const requestBody = JSON.stringify({ op, ...params })

  let raw: GatewayRawResponse
  try {
    raw = await sendGatewayRequest(gatewayEndpoint(config), { method: 'POST', body: requestBody, headers: gatewayHeaders(config) }, DEFAULT_TIMEOUT_MS, resolveGatewayTransport())
  } catch (networkError) {
    const isTimeout = networkError instanceof Error && (networkError.name === 'AbortError' || /timed out/i.test(networkError.message))
    const code = networkErrorCode(networkError)
    const message = networkError instanceof Error ? networkError.message : 'Unknown network error'
    throw new GatewayCommandError(
      isTimeout
        ? `Redis Gateway request timed out after ${DEFAULT_TIMEOUT_MS}ms${code ? ` (${code})` : ''}`
        : `Redis Gateway request failed: ${message}${code ? ` (${code})` : ''}`,
      null,
      op,
    )
  }

  // A redirect (e.g. to a Cloudflare Access / WAF challenge or login page)
  // must never be followed silently — it means we didn't actually reach the
  // Gateway, which "the Gateway returned a 4xx/5xx" doesn't capture.
  if (raw.redirected) {
    throw new GatewayCommandError(
      `Redis Gateway op "${op}" received a redirect instead of a direct response — check REDIS_GATEWAY_URL/Cloudflare Access configuration, not the Gateway's own logic`,
      raw.status || null,
      op,
    )
  }

  // An HTML body (instead of the documented JSON envelope) is the other
  // classic sign of hitting a proxy/WAF/challenge page in front of the
  // Gateway rather than the Gateway itself — surfaced as its own condition
  // rather than failing confusingly on JSON.parse.
  if (raw.contentType && /text\/html/i.test(raw.contentType)) {
    throw new GatewayCommandError(
      `Redis Gateway op "${op}" returned HTML (status ${raw.status}, content-type ${raw.contentType}) instead of JSON — likely a proxy/WAF/Access page in front of the Gateway`,
      raw.status,
      op,
    )
  }

  let parsed: { result?: unknown; error?: string } | null = null
  if (raw.bodyText) {
    try {
      parsed = JSON.parse(raw.bodyText) as { result?: unknown; error?: string }
    } catch {
      throw new GatewayCommandError(`Redis Gateway op "${op}" returned a response that is not valid JSON (status ${raw.status})`, raw.status, op)
    }
  }

  if (raw.status < 200 || raw.status >= 300) {
    throw new GatewayCommandError(`Redis Gateway op "${op}" failed (${raw.status}): ${parsed?.error ?? 'no error detail in response'}`, raw.status, op)
  }

  // A 2xx body that parsed as JSON but isn't the documented {result}/{error}
  // envelope (e.g. an upstream proxy's own "ok" JSON page) must not be
  // silently treated as `result: undefined` — that's indistinguishable from
  // a real null/undefined result and would hide a real misconfiguration.
  if (parsed !== null && !('result' in parsed) && !('error' in parsed)) {
    throw new GatewayCommandError(`Redis Gateway op "${op}" returned an unexpected response shape (missing "result"/"error")`, raw.status, op)
  }

  return parsed?.result
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

// ---- Typed per-op helpers — see docs/REDIS_GATEWAY.md for the exact
// contract (argument types, range semantics, TTL semantics, error
// behavior) each of these assumes. ----

export async function gatewayGet(config: GatewayConfig, key: string): Promise<string | null> {
  const result = await gatewayCall(config, 'get', { key })
  return typeof result === 'string' ? result : null
}

export type GatewaySetOptions = { nx?: boolean; xx?: boolean; exSeconds?: number; pxMs?: number }

/**
 * Native conditional SET. The Gateway performs the NX/XX check and the
 * value write as one atomic server-side operation — this is a single
 * request, never a claim-then-write sequence. Returns 'OK' on a successful
 * write, or null when a condition (NX: key already exists; XX: key doesn't
 * exist) prevented it — the same contract Upstash's native SET NX/XX has,
 * which is what every caller already branches on.
 */
export async function gatewaySet(config: GatewayConfig, key: string, value: string, options: GatewaySetOptions = {}): Promise<'OK' | null> {
  const params: Record<string, unknown> = { key, value }
  if (options.nx) params.nx = true
  if (options.xx) params.xx = true
  if (options.exSeconds != null) params.ex = options.exSeconds
  if (options.pxMs != null) params.px = options.pxMs
  const result = await gatewayCall(config, 'set', params)
  return result === 'OK' || result === true ? 'OK' : null
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

export async function gatewayMget(config: GatewayConfig, keys: string[]): Promise<(string | null)[]> {
  if (keys.length === 0) return []
  const result = await gatewayCall(config, 'mget', { keys })
  if (!Array.isArray(result)) return keys.map(() => null)
  return result.map((item) => (typeof item === 'string' ? item : null))
}

export async function gatewayLpush(config: GatewayConfig, key: string, value: string): Promise<number> {
  return Number(await gatewayCall(config, 'lpush', { key, value })) || 0
}

export async function gatewayLtrim(config: GatewayConfig, key: string, start: number, stop: number): Promise<void> {
  await gatewayCall(config, 'ltrim', { key, start, stop })
}

export async function gatewayLrange(config: GatewayConfig, key: string, start: number, stop: number): Promise<string[]> {
  const result = await gatewayCall(config, 'lrange', { key, start, stop })
  return Array.isArray(result) ? result.filter((item): item is string => typeof item === 'string') : []
}

export async function gatewayZadd(config: GatewayConfig, key: string, score: number, member: string): Promise<number> {
  return Number(await gatewayCall(config, 'zadd', { key, score, member })) || 0
}

export async function gatewayZrem(config: GatewayConfig, key: string, member: string): Promise<number> {
  return Number(await gatewayCall(config, 'zrem', { key, member })) || 0
}

export async function gatewayZrevrange(config: GatewayConfig, key: string, start: number, stop: number): Promise<string[]> {
  const result = await gatewayCall(config, 'zrevrange', { key, start, stop })
  return Array.isArray(result) ? result.filter((item): item is string => typeof item === 'string') : []
}

export type ZRangeByScoreLimit = { offset: number; count: number }

export async function gatewayZrangebyscore(
  config: GatewayConfig,
  key: string,
  min: string | number,
  max: string | number,
  limit?: ZRangeByScoreLimit,
): Promise<string[]> {
  const params: Record<string, unknown> = { key, min: String(min), max: String(max) }
  if (limit) {
    params.offset = limit.offset
    params.count = limit.count
  }
  const result = await gatewayCall(config, 'zrangebyscore', params)
  return Array.isArray(result) ? result.filter((item): item is string => typeof item === 'string') : []
}

// ---- Raw Redis command translator — what kv.ts's kvCommand() calls under
// REDIS_PROVIDER=http, so every existing repository keeps issuing the same
// command arrays it already does for Upstash. Every branch below is a 1:1
// translation to a single Gateway request — no multi-call emulation. ----

function parseSetArgs(args: (string | number)[]): GatewaySetOptions {
  const options: GatewaySetOptions = {}
  for (let i = 2; i < args.length; i += 1) {
    const token = String(args[i]).toUpperCase()
    if (token === 'NX') options.nx = true
    else if (token === 'XX') options.xx = true
    else if (token === 'EX') {
      options.exSeconds = Number(args[i + 1])
      i += 1
    } else if (token === 'PX') {
      options.pxMs = Number(args[i + 1])
      i += 1
    }
  }
  return options
}

function parseZRangeByScoreArgs(args: (string | number)[]): { key: string; min: string; max: string; limit?: ZRangeByScoreLimit } {
  const key = String(args[0])
  const min = String(args[1])
  const max = String(args[2])
  const limitIndex = args.findIndex((value, index) => index >= 3 && String(value).toUpperCase() === 'LIMIT')
  if (limitIndex === -1) return { key, min, max }
  const limit = { offset: Number(args[limitIndex + 1]), count: Number(args[limitIndex + 2]) }
  return { key, min, max, limit }
}

/** Routes one raw Redis command array (the same shape every repository already builds for Upstash) to the Gateway's op set. */
export async function gatewayExecuteRedisCommand(config: GatewayConfig, command: (string | number)[]): Promise<unknown> {
  const [verbRaw, ...args] = command
  const verb = String(verbRaw).toUpperCase()
  switch (verb) {
    case 'GET':
      return gatewayGet(config, String(args[0]))
    case 'SET':
      return gatewaySet(config, String(args[0]), String(args[1]), parseSetArgs(args))
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
      return gatewayMget(config, args.map(String))
    case 'SADD':
      return gatewaySadd(config, String(args[0]), String(args[1]))
    case 'SREM':
      return gatewaySrem(config, String(args[0]), String(args[1]))
    case 'SMEMBERS':
      return gatewaySmembers(config, String(args[0]))
    case 'SCARD':
      return gatewayScard(config, String(args[0]))
    case 'LPUSH':
      return gatewayLpush(config, String(args[0]), String(args[1]))
    case 'LTRIM':
      return gatewayLtrim(config, String(args[0]), Number(args[1]), Number(args[2]))
    case 'LRANGE':
      return gatewayLrange(config, String(args[0]), Number(args[1]), Number(args[2]))
    case 'ZADD':
      return gatewayZadd(config, String(args[0]), Number(args[1]), String(args[2]))
    case 'ZREM':
      return gatewayZrem(config, String(args[0]), String(args[1]))
    case 'ZREVRANGE':
      return gatewayZrevrange(config, String(args[0]), Number(args[1]), Number(args[2]))
    case 'ZRANGEBYSCORE': {
      const parsed = parseZRangeByScoreArgs(args)
      return gatewayZrangebyscore(config, parsed.key, parsed.min, parsed.max, parsed.limit)
    }
    default:
      throw new GatewayUnsupportedCommandError(verb, 'no Gateway operation covers this command')
  }
}
