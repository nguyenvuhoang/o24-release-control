// Shared Redis-REST client (Vercel KV and Upstash Redis both speak the same
// single-command REST protocol: POST {url} with a JSON command array, Bearer
// token auth) — no extra npm dependency needed. Used by both the audit trail
// (auditRepository.ts) and the build-pointer hint store (buildPointerStore.ts)
// so there is exactly one place that knows how to talk to KV.

export type KvConfig = { url: string; token: string }

export function resolveKvConfig(): KvConfig | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null
  return { url, token }
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

async function kvCommandOnce(config: KvConfig, command: (string | number)[]): Promise<unknown> {
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
 * login failures observed in production.
 */
export async function kvCommand(config: KvConfig, command: (string | number)[]): Promise<unknown> {
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
