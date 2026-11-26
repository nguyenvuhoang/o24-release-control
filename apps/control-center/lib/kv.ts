// Shared Redis client. Every repository (audit, releases, build pointers,
// snapshot jobs, users) builds a raw Redis command array — `['SET', key,
// value, 'NX']`, `['ZADD', key, score, member]`, etc. — and calls
// kvCommand(config, command) without caring which backend answers it. Which
// backend that is is the ONE thing this file decides, via REDIS_PROVIDER:
//  - unset / "upstash" (default): Vercel KV / Upstash Redis's REST protocol
//    (POST {url} with the command array as the body, Bearer token auth).
//  - "http": the self-hosted HTTP Redis Gateway (see ./redisGateway.ts),
//    which speaks a different, more restricted protocol (POST {url}/v1/redis
//    with {op, ...} — see docs/REDIS_GATEWAY.md) that redisGateway.ts
//    translates each command array into.
// Resolved fresh on every call rather than cached in a module-level
// singleton, specifically so a Next.js dev hot-reload can never leave a
// request running against a stale provider selection.

import {
  gatewayExecuteRedisCommand,
  resolveGatewayConfig,
  type GatewayConfig,
} from './redisGateway'

export type KvConfig = { provider: 'upstash'; url: string; token: string } | { provider: 'http'; gateway: GatewayConfig }

export class RedisConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RedisConfigError'
  }
}

function resolveProviderKind(): 'upstash' | 'http' {
  return (process.env.REDIS_PROVIDER ?? '').trim().toLowerCase() === 'http' ? 'http' : 'upstash'
}

export function resolveKvConfig(): KvConfig | null {
  if (resolveProviderKind() === 'http') {
    const gateway = resolveGatewayConfig()
    if (!gateway) {
      // REDIS_PROVIDER=http is an explicit choice, not "KV isn't configured"
      // — silently falling back to the in-memory/file tiers here would hide
      // a real misconfiguration behind what looks like a healthy (but
      // non-durable) response. Fail loud instead.
      throw new RedisConfigError(
        'REDIS_PROVIDER=http but REDIS_GATEWAY_URL/REDIS_GATEWAY_TOKEN are not both set — refusing to silently fall back to in-memory/file storage',
      )
    }
    return { provider: 'http', gateway }
  }

  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null
  return { provider: 'upstash', url, token }
}

// Bounded per-attempt timeout — a hung KV connection on a serverless
// function must never block indefinitely (this is the single chokepoint
// behind audit, release snapshots, build pointers, registry status and
// non-admin login — an unbounded hang here is exactly what cascades into
// simultaneous failures across all of them). Overridable, always bounded.
const DEFAULT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.KV_REQUEST_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 5_000
})()
const MAX_RETRIES = 2 // up to 3 total attempts
const BASE_RETRY_DELAY_MS = 150
const MAX_RETRY_DELAY_MS = 1_500

export class KvCommandError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
  ) {
    super(message)
    this.name = 'KvCommandError'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Transient (worth a bounded retry): the request never reached the server,
// timed out, or the server itself reported an overload/5xx. NOT retryable:
// any 4xx (bad command, bad auth, bad token) — retrying those can never
// change the outcome and only adds load during an incident.
function isTransient(error: unknown): boolean {
  if (error instanceof KvCommandError) return error.status === null || error.status >= 500
  return true // network/timeout errors never reach KvCommandError construction
}

async function kvCommandOnce(config: { url: string; token: string }, command: (string | number)[]): Promise<unknown> {
  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(config.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      cache: 'no-store',
      signal: controller.signal,
    })
  } catch (networkError) {
    const isTimeout = networkError instanceof Error && networkError.name === 'AbortError'
    const message = networkError instanceof Error ? networkError.message : 'Unknown network error'
    throw new KvCommandError(isTimeout ? `KV request timed out after ${DEFAULT_TIMEOUT_MS}ms` : `KV request failed: ${message}`, null)
  } finally {
    clearTimeout(timeoutHandle)
  }

  const body = (await response.json().catch(() => null)) as { result?: unknown; error?: string } | null
  if (!response.ok) {
    throw new KvCommandError(`KV command failed (${response.status}): ${body?.error ?? response.statusText}`, response.status)
  }
  return body?.result
}

/**
 * Bounded retry (3 attempts total) with backoff + jitter for transient KV
 * failures (timeout, network error, 5xx) — a 4xx is never retried. This is
 * the ONE place every KV-backed repository (audit, releases, build
 * pointers, snapshot jobs, users) goes through, so hardening it here fixes
 * the shared chokepoint behind the simultaneous audit/snapshot/registry/
 * login failures observed in production. Under REDIS_PROVIDER=http this
 * delegates the whole command to redisGateway.ts instead — see that file's
 * gatewayExecuteRedisCommand for the Gateway's own retry/timeout handling.
 */
export async function kvCommand(config: KvConfig, command: (string | number)[]): Promise<unknown> {
  if (config.provider === 'http') {
    return gatewayExecuteRedisCommand(config.gateway, command)
  }

  let attempt = 0
  for (;;) {
    try {
      return await kvCommandOnce(config, command)
    } catch (error) {
      if (attempt >= MAX_RETRIES || !isTransient(error)) throw error
      const base = Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS)
      const jittered = Math.round(base * (0.5 + Math.random()))
      await sleep(jittered)
      attempt += 1
    }
  }
}

export function isRunningOnVercel(): boolean {
  return Boolean(process.env.VERCEL)
}
