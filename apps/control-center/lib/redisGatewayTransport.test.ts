import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolveGatewayTransport, sendGatewayRequestViaFetch } from './redisGatewayTransport'

async function withServer(handler: http.RequestListener, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address() as AddressInfo
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('resolveGatewayTransport defaults to fetch, and only "https-agent" (case-insensitive) switches it', () => {
  const original = process.env.REDIS_GATEWAY_TRANSPORT
  try {
    delete process.env.REDIS_GATEWAY_TRANSPORT
    assert.equal(resolveGatewayTransport(), 'fetch')
    process.env.REDIS_GATEWAY_TRANSPORT = 'HTTPS-Agent'
    assert.equal(resolveGatewayTransport(), 'https-agent')
    process.env.REDIS_GATEWAY_TRANSPORT = 'something-else'
    assert.equal(resolveGatewayTransport(), 'fetch')
  } finally {
    if (original === undefined) delete process.env.REDIS_GATEWAY_TRANSPORT
    else process.env.REDIS_GATEWAY_TRANSPORT = original
  }
})

test('sendGatewayRequestViaFetch returns status/contentType/bodyText for a normal JSON response', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'CF-Ray': 'abc123-SIN' })
      res.end(JSON.stringify({ result: 'ok' }))
    },
    async (baseUrl) => {
      const raw = await sendGatewayRequestViaFetch(`${baseUrl}/v1/redis`, { method: 'POST', body: '{}', headers: {} }, 2000)
      assert.equal(raw.status, 200)
      assert.equal(raw.contentType, 'application/json')
      assert.equal(raw.cfRay, 'abc123-SIN')
      assert.equal(raw.redirected, false)
      assert.equal(raw.bodyText, JSON.stringify({ result: 'ok' }))
      assert.ok(raw.timings.totalMs >= 0)
      assert.ok(raw.timings.ttfbMs >= 0)
    },
  )
})

test('sendGatewayRequestViaFetch reports a 3xx response as redirected, with the real status (not followed)', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(302, { Location: '/somewhere-else' })
      res.end()
    },
    async (baseUrl) => {
      const raw = await sendGatewayRequestViaFetch(`${baseUrl}/v1/redis`, { method: 'GET', headers: {} }, 2000)
      assert.equal(raw.status, 302)
      assert.equal(raw.redirected, true)
    },
  )
})

test('sendGatewayRequestViaFetch surfaces an HTML response via contentType, distinguishable from the documented JSON envelope', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html><body>Attention Required! | Cloudflare</body></html>')
    },
    async (baseUrl) => {
      const raw = await sendGatewayRequestViaFetch(`${baseUrl}/v1/redis`, { method: 'POST', body: '{}', headers: {} }, 2000)
      assert.equal(raw.status, 200)
      assert.match(raw.contentType ?? '', /text\/html/)
      assert.match(raw.bodyText, /Cloudflare/)
    },
  )
})

// ---- Regression: the pre-incident version of this code cleared its abort
// timeout right after fetch() resolved with HEADERS, before reading the
// body — so a connection that sent headers promptly but then stalled mid-
// body would hang forever, with no timeout protection at all. This proves
// the fix: the abort signal must still be live (and still able to cut the
// request short) while the body is being consumed. ----

test('sendGatewayRequestViaFetch times out even when headers arrive promptly but the body then stalls (timeout covers body read, not just connect)', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.flushHeaders()
      // Deliberately never calls res.end() or writes a body — holds the
      // connection open indefinitely, simulating a stalled response body.
    },
    async (baseUrl) => {
      const start = Date.now()
      await assert.rejects(() => sendGatewayRequestViaFetch(`${baseUrl}/v1/redis`, { method: 'GET', headers: {} }, 150), /AbortError|aborted/i)
      const elapsed = Date.now() - start
      // Generous upper bound (CI jitter) — the point is "well under a
      // second", not "exactly 150ms"; the pre-fix bug would have hung for
      // the whole test run (effectively forever) instead.
      assert.ok(elapsed < 5000, `expected the stalled body to time out quickly, took ${elapsed}ms`)
    },
  )
})
