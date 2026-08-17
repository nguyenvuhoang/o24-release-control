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

export async function kvCommand(config: KvConfig, command: (string | number)[]): Promise<unknown> {
  const response = await fetch(config.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    cache: 'no-store',
  })
  const body = (await response.json().catch(() => null)) as { result?: unknown; error?: string } | null
  if (!response.ok) {
    throw new Error(`KV command failed (${response.status}): ${body?.error ?? response.statusText}`)
  }
  return body?.result
}

export function isRunningOnVercel(): boolean {
  return Boolean(process.env.VERCEL)
}
