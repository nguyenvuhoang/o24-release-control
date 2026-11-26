// Low-level HTTP transport for talking to the self-hosted Redis Gateway,
// factored out of redisGateway.ts so the op/retry contract in that file
// never has to care which transport actually sent the bytes. See
// docs/REDIS_GATEWAY.md's "2026-11-26 Vercel transport incident" note for
// why this exists: production Gateway calls were timing out after the full
// 15000ms budget, uniformly across every op (read and write), unaffected by
// concurrency or by changing the timeout value — the opposite of what an
// overloaded-server or retry-storm symptom looks like, and consistent
// instead with a transport-level dead end (e.g. a serverless runtime
// connecting over a route that never completes) that happens to resolve
// right at the timeout boundary rather than failing fast.
//
// Two implementations, both honoring the SAME request/response shape:
//  - 'fetch' (default): Node's built-in fetch/undici — behavior preserved
//    from before this file existed (same headers, same no-store/manual-
//    redirect semantics), just extracted so it can be measured against the
//    alternative below.
//  - 'https-agent' (opt-in via REDIS_GATEWAY_TRANSPORT=https-agent): a
//    dedicated node:https.Agent with keep-alive and an explicit IPv4
//    preference (REDIS_GATEWAY_URL resolves to both an IPv4 and an IPv6
//    Cloudflare address — see instrumentation.ts), with socket-level
//    timing (DNS lookup / TCP connect / TLS handshake / time-to-first-byte)
//    for actually diagnosing where a slow or hung request is spending its
//    time, not just that it eventually failed. Never used unless explicitly
//    selected — this never changes the transport ANY other HTTP client in
//    this codebase (GitHub, Docker Hub, Deploy Agent) uses, and never
//    weakens TLS certificate verification.
import https from 'node:https'
import { performance } from 'node:perf_hooks'

export type GatewayRequestInit = {
  method: 'GET' | 'POST'
  body?: string
  headers: Record<string, string>
}

export type GatewayTimings = {
  totalMs: number
  /** Only populated by the https-agent transport — plain fetch/undici doesn't expose per-phase connection timing. */
  dnsMs?: number
  tcpConnectMs?: number
  tlsHandshakeMs?: number
  ttfbMs: number
  bodyReadMs: number
}

export type GatewayRawResponse = {
  /** 0 for an opaque/manual redirect (the response body/headers are intentionally not exposed in that case). */
  status: number
  contentType: string | null
  cfRay: string | null
  redirected: boolean
  bodyText: string
  timings: GatewayTimings
}

export type GatewayTransport = 'fetch' | 'https-agent'

export function resolveGatewayTransport(): GatewayTransport {
  const raw = (process.env.REDIS_GATEWAY_TRANSPORT ?? '').trim().toLowerCase()
  return raw === 'https-agent' ? 'https-agent' : 'fetch'
}

/**
 * fetch/undici transport. The ONE timeout covers the whole lifecycle
 * (connect through full body read) — the AbortController isn't released
 * until after `response.text()` resolves, unlike the pre-incident version
 * of this code, which cleared its timeout right after `fetch()` itself
 * resolved, leaving body consumption completely unbounded.
 */
export async function sendGatewayRequestViaFetch(url: string, init: GatewayRequestInit, timeoutMs: number): Promise<GatewayRawResponse> {
  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)
  const start = performance.now()
  try {
    const response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      cache: 'no-store',
      redirect: 'manual', // a redirect (e.g. to a WAF/Access challenge/login page) must surface as a diagnosable condition, never be followed silently
      signal: controller.signal,
    })
    const ttfbMs = performance.now() - start
    const bodyText = await response.text()
    const totalMs = performance.now() - start
    // Verified empirically (see docs/REDIS_GATEWAY.md's transport-incident
    // note): outside a browser's navigation context, Node's fetch/undici
    // does NOT turn a `redirect: 'manual'` 3xx into an opaque "opaqueredirect"
    // response the way a Service Worker interception would — it returns the
    // real 3xx status directly, `response.type` stays 'basic'/'cors'. A
    // status-range check is the actual, confirmed signal here; the
    // opaqueredirect check is kept only as defense-in-depth should that ever
    // change.
    const isOpaqueRedirect = response.type === 'opaqueredirect'
    const isStatusRedirect = response.status >= 300 && response.status < 400
    return {
      status: isOpaqueRedirect ? 0 : response.status,
      contentType: response.headers.get('content-type'),
      cfRay: response.headers.get('cf-ray'),
      redirected: isOpaqueRedirect || isStatusRedirect || response.redirected,
      bodyText,
      timings: { totalMs, ttfbMs, bodyReadMs: totalMs - ttfbMs },
    }
  } finally {
    clearTimeout(timeoutHandle)
  }
}

// Shared across calls so keep-alive connections are actually reused instead
// of re-negotiating TLS on every request — part of "connection reuse" from
// the https-agent evaluation. Lazily constructed so importing this module
// never has a side effect for the (default) fetch-only path.
let sharedHttpsAgent: https.Agent | null = null
function getSharedHttpsAgent(): https.Agent {
  if (!sharedHttpsAgent) {
    sharedHttpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 32,
      family: 4, // explicit IPv4 preference at the Agent level too, independent of instrumentation.ts's process-wide DNS_RESULT_ORDER setting
    })
  }
  return sharedHttpsAgent
}

/**
 * node:https transport with socket-level phase timing and a single deadline
 * covering connect + TLS + headers + body — the whole request, not just the
 * connect phase. Standard certificate verification stays on
 * (rejectUnauthorized defaults to true and is never overridden here).
 */
export function sendGatewayRequestViaHttpsAgent(url: string, init: GatewayRequestInit, timeoutMs: number): Promise<GatewayRawResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const start = performance.now()
    let lookupAt: number | undefined
    let connectAt: number | undefined
    let secureConnectAt: number | undefined

    const headers = init.body ? { ...init.headers, 'Content-Length': String(Buffer.byteLength(init.body)) } : init.headers

    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: init.method,
        headers,
        agent: getSharedHttpsAgent(),
        family: 4,
      },
      (res) => {
        const headersAt = performance.now()
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          clearTimeout(deadline)
          const totalMs = performance.now() - start
          const status = res.statusCode ?? 0
          resolve({
            status,
            contentType: (res.headers['content-type'] as string | undefined) ?? null,
            cfRay: (res.headers['cf-ray'] as string | undefined) ?? null,
            redirected: status >= 300 && status < 400,
            bodyText: Buffer.concat(chunks).toString('utf8'),
            timings: {
              totalMs,
              dnsMs: lookupAt !== undefined ? lookupAt - start : undefined,
              tcpConnectMs: connectAt !== undefined && lookupAt !== undefined ? connectAt - lookupAt : undefined,
              tlsHandshakeMs: secureConnectAt !== undefined && connectAt !== undefined ? secureConnectAt - connectAt : undefined,
              ttfbMs: headersAt - start,
              bodyReadMs: totalMs - (headersAt - start),
            },
          })
        })
        res.on('error', (error) => {
          clearTimeout(deadline)
          reject(error)
        })
      },
    )

    req.on('socket', (socket) => {
      socket.once('lookup', () => {
        lookupAt = performance.now()
      })
      socket.once('connect', () => {
        connectAt = performance.now()
      })
      socket.once('secureConnect', () => {
        secureConnectAt = performance.now()
      })
    })

    const deadline = setTimeout(() => {
      req.destroy(new Error(`Redis Gateway request (https-agent transport) timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    req.on('error', (error) => {
      clearTimeout(deadline)
      reject(error)
    })

    req.end(init.body)
  })
}

export async function sendGatewayRequest(url: string, init: GatewayRequestInit, timeoutMs: number, transport: GatewayTransport = resolveGatewayTransport()): Promise<GatewayRawResponse> {
  return transport === 'https-agent' ? sendGatewayRequestViaHttpsAgent(url, init, timeoutMs) : sendGatewayRequestViaFetch(url, init, timeoutMs)
}
