import { NextResponse } from 'next/server'
import dns from 'node:dns/promises'
import { performance } from 'node:perf_hooks'
import { requireApiSession, errorResponse } from '../../../../lib/api'
import { GATEWAY_REQUEST_TIMEOUT_MS, resolveGatewayConfig } from '../../../../lib/redisGateway'
import { sendGatewayRequestViaFetch, sendGatewayRequestViaHttpsAgent, type GatewayRawResponse } from '../../../../lib/redisGatewayTransport'

export const dynamic = 'force-dynamic'

// Admin-only (same single-admin gate every other API route uses — see
// lib/auth.ts; this app has no roles to further restrict by) read-only
// transport diagnostic for the production "Redis Gateway request timed out
// after 15000ms" incident — see docs/REDIS_GATEWAY.md's
// "2026-11-26 Vercel transport incident" note. Never writes anything: the
// two keys below are synthetic and never created by any real repository, so
// a `get`/`mget` against them can only ever read null, never real
// release/audit/user data. Never returns raw response bodies, header
// values, or the Gateway token/CF-Access secret — only status/timing/content-
// type/error-code metadata, which is what a transport diagnosis actually
// needs.
const DIAGNOSTIC_KEY_A = 'o24:diag:ping'
const DIAGNOSTIC_KEY_B = 'o24:diag:ping2'

type ProbeReport = {
  name: string
  transport: 'fetch' | 'https-agent'
  method: 'GET' | 'POST'
  path: string
  ok: boolean
  httpStatus: number | null
  contentType: string | null
  cfRay: string | null
  redirected: boolean
  bodyLength: number | null
  looksLikeHtml: boolean
  timings: GatewayRawResponse['timings'] | null
  errorCode: string | null
  errorMessage: string | null
}

function networkErrorInfo(error: unknown): { code: string | null; message: string } {
  if (!error || typeof error !== 'object') return { code: null, message: 'Unknown error' }
  const withCode = error as { code?: unknown; cause?: { code?: unknown }; message?: unknown; name?: unknown }
  const rawCode = withCode.code ?? withCode.cause?.code
  const message = typeof withCode.message === 'string' ? withCode.message : 'Unknown error'
  const isTimeout = withCode.name === 'AbortError' || /timed out/i.test(message)
  return { code: typeof rawCode === 'string' ? rawCode : isTimeout ? 'TIMEOUT' : null, message }
}

async function runProbe(
  name: string,
  transport: 'fetch' | 'https-agent',
  method: 'GET' | 'POST',
  url: string,
  path: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<ProbeReport> {
  const base = { name, transport, method, path }
  try {
    const raw = await (transport === 'fetch'
      ? sendGatewayRequestViaFetch(url, { method, body, headers }, GATEWAY_REQUEST_TIMEOUT_MS)
      : sendGatewayRequestViaHttpsAgent(url, { method, body, headers }, GATEWAY_REQUEST_TIMEOUT_MS))
    return {
      ...base,
      ok: raw.status >= 200 && raw.status < 300,
      httpStatus: raw.status,
      contentType: raw.contentType,
      cfRay: raw.cfRay,
      redirected: raw.redirected,
      bodyLength: raw.bodyText.length,
      looksLikeHtml: /text\/html/i.test(raw.contentType ?? '') || /^\s*<!doctype html|^\s*<html/i.test(raw.bodyText),
      timings: raw.timings,
      errorCode: null,
      errorMessage: null,
    }
  } catch (error) {
    const info = networkErrorInfo(error)
    return {
      ...base,
      ok: false,
      httpStatus: null,
      contentType: null,
      cfRay: null,
      redirected: false,
      bodyLength: null,
      looksLikeHtml: false,
      timings: null,
      errorCode: info.code,
      errorMessage: info.message,
    }
  }
}

export async function GET() {
  const session = await requireApiSession()
  if (session instanceof NextResponse) return session

  try {
    const config = resolveGatewayConfig()
    if (!config) {
      return NextResponse.json(
        {
          error: 'gateway_not_configured',
          details: 'REDIS_PROVIDER=http but REDIS_GATEWAY_URL/REDIS_GATEWAY_TOKEN are not set in this environment — nothing to diagnose.',
        },
        { status: 400 },
      )
    }

    const baseUrl = config.url.replace(/\/+$/, '')
    const redisUrl = `${baseUrl}/v1/redis`
    const healthUrl = `${baseUrl}/health`
    const hostname = new URL(baseUrl).hostname

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.token}`,
      ...(config.cfAccessClientId ? { 'CF-Access-Client-Id': config.cfAccessClientId } : {}),
      ...(config.cfAccessClientSecret ? { 'CF-Access-Client-Secret': config.cfAccessClientSecret } : {}),
    }

    // Resolved once and shared as context for every probe below — the
    // concrete data point behind instrumentation.ts's IPv4-preference fix:
    // if this host resolves to both an A and an AAAA record from THIS
    // runtime too, that's the clearest evidence of exactly the dead-end-
    // single-address-attempt risk that fix targets.
    let dnsReport: { durationMs: number; addresses: Array<{ address: string; family: number }> } | { error: string }
    const dnsStart = performance.now()
    try {
      const addresses = await dns.lookup(hostname, { all: true })
      dnsReport = { durationMs: performance.now() - dnsStart, addresses: addresses.map((entry) => ({ address: entry.address, family: entry.family })) }
    } catch (error) {
      dnsReport = { error: error instanceof Error ? error.message : 'Unknown DNS error' }
    }

    const getBody = JSON.stringify({ op: 'get', key: DIAGNOSTIC_KEY_A })
    const mgetBody = JSON.stringify({ op: 'mget', keys: [DIAGNOSTIC_KEY_A, DIAGNOSTIC_KEY_B] })

    // Sequential, not parallel — the whole point of this endpoint is to
    // diagnose the Gateway's transport, not to add more concurrent load to
    // it while doing so (see docs/REDIS_GATEWAY.md on exactly that mistake).
    const probes: ProbeReport[] = []
    probes.push(await runProbe('native fetch GET /health', 'fetch', 'GET', healthUrl, '/health', headers, undefined))
    probes.push(await runProbe('native fetch POST /v1/redis (get)', 'fetch', 'POST', redisUrl, '/v1/redis', headers, getBody))
    probes.push(await runProbe('native fetch POST /v1/redis (mget)', 'fetch', 'POST', redisUrl, '/v1/redis', headers, mgetBody))
    probes.push(await runProbe('node:https GET /health', 'https-agent', 'GET', healthUrl, '/health', headers, undefined))
    probes.push(await runProbe('node:https POST /v1/redis (get)', 'https-agent', 'POST', redisUrl, '/v1/redis', headers, getBody))
    probes.push(await runProbe('node:https POST /v1/redis (mget)', 'https-agent', 'POST', redisUrl, '/v1/redis', headers, mgetBody))

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      gatewayHost: hostname,
      configuredTimeoutMs: GATEWAY_REQUEST_TIMEOUT_MS,
      dns: dnsReport,
      // GET /health is NOT part of the documented Gateway contract
      // (docs/REDIS_GATEWAY.md only specifies POST /v1/redis) — it may
      // legitimately 404. A 404 there (vs. a hang/timeout) is itself a
      // useful result: it means the connection/TLS/response cycle completed
      // fine, just against a route that doesn't exist.
      note: 'GET /health is a best-effort probe, not part of the documented Gateway contract — a 404 there is a successful transport result.',
      probes,
    })
  } catch (error) {
    return errorResponse(error)
  }
}
