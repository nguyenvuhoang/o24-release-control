import { createHash, createHmac, randomUUID } from 'node:crypto'
import { readJsonSafe } from './http'
import type { EnvironmentConfig } from './types'

type AgentRequestOptions = {
  method?: 'GET' | 'POST'
  body?: unknown
  timeoutMs?: number
}

function buildRequest(environment: EnvironmentConfig, path: string, method: 'GET' | 'POST', body: unknown) {
  const url = new URL(path, environment.baseUrl.endsWith('/') ? environment.baseUrl : `${environment.baseUrl}/`)
  const encodedBody = body === undefined ? '' : JSON.stringify(body)
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const bodyHash = createHash('sha256').update(encodedBody).digest('hex')
  const canonical = `${method}\n${url.pathname}${url.search}\n${timestamp}\n${bodyHash}`
  const signature = createHmac('sha256', environment.apiSecret).update(canonical).digest('hex')

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-O24-Agent-Key': environment.apiKey,
    'X-O24-Timestamp': timestamp,
    'X-O24-Signature': signature,
    'X-O24-Request-Id': randomUUID(),
  }
  if (environment.cfAccessClientId && environment.cfAccessClientSecret) {
    headers['CF-Access-Client-Id'] = environment.cfAccessClientId
    headers['CF-Access-Client-Secret'] = environment.cfAccessClientSecret
  }
  return { url, headers, body: encodedBody }
}

export async function callAgent<T>(
  environment: EnvironmentConfig,
  path: string,
  options: AgentRequestOptions = {},
): Promise<T> {
  const method = options.method ?? 'GET'
  const { url, headers, body } = buildRequest(environment, path, method, options.body)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000)
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: method === 'GET' ? undefined : body,
      cache: 'no-store',
      signal: controller.signal,
    })

    let parsed: unknown
    try {
      parsed = await readJsonSafe(response)
    } catch (parseError) {
      // Non-empty but invalid JSON body — log without leaking the HMAC secret.
      console.error('[agent] invalid JSON response', {
        upstreamStatus: response.status,
        environment: environment.code,
        path,
      })
      throw new Error(`${environment.code}: ${parseError instanceof Error ? parseError.message : 'invalid response'}`)
    }

    if (parsed === null) {
      console.error('[agent] empty response body', {
        upstreamStatus: response.status,
        environment: environment.code,
        path,
      })
      if (response.ok) {
        throw new Error(`${environment.code}: agent returned an empty response body (status ${response.status})`)
      }
    }

    if (!response.ok) {
      const message = typeof parsed === 'object' && parsed && 'details' in parsed
        ? String((parsed as { details?: unknown }).details ?? response.statusText)
        : response.statusText
      throw new Error(`${environment.code}: ${message}`)
    }
    return parsed as T
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Opens an authenticated GET request to the agent and returns the raw
 * Response so its body (e.g. an SSE stream) can be piped straight through to
 * the browser without buffering or JSON parsing.
 */
export async function streamAgent(environment: EnvironmentConfig, path: string): Promise<Response> {
  const { url, headers } = buildRequest(environment, path, 'GET', undefined)
  const response = await fetch(url, {
    method: 'GET',
    headers: { ...headers, Accept: 'text/event-stream' },
    cache: 'no-store',
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${environment.code}: agent stream failed (${response.status}) ${text}`)
  }
  return response
}
