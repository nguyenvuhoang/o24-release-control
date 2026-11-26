import assert from 'node:assert/strict'
import test from 'node:test'

process.env.GITHUB_TOKEN = 'test-token'
process.env.GITHUB_OWNER = 'test-owner'
process.env.GITHUB_REPO = 'test-repo'
process.env.GITHUB_WORKFLOW = 'build-o24.yml'
// Keeps the retry/backoff tests below fast — real production defaults
// (300ms-4s backoff) would make this file take many seconds otherwise.
process.env.GITHUB_REQUEST_TIMEOUT_MS = '2000'

const {
  GithubAuthError,
  GithubNetworkError,
  GithubPermissionError,
  GithubRateLimitError,
  GithubServerError,
  findLatestGithubRunForService,
  getCommitMessage,
  getWorkflowRun,
  resetGithubRunsListCacheForTests,
  triggerWorkflowBuild,
} = await import('./client')

test.beforeEach(() => {
  resetGithubRunsListCacheForTests()
})

function mockFetchOnce(status: number, body: unknown, headers: Record<string, string> = {}) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })) as typeof fetch
  return () => {
    globalThis.fetch = originalFetch
  }
}

type FetchHandler = () => Response | Promise<Response> | never

// Sequence-based mock — each call consumes the next handler, so a test can
// script "fail N times then succeed" exactly like the real retry/backoff
// logic will encounter in production.
function mockFetchSequence(handlers: FetchHandler[]) {
  const originalFetch = globalThis.fetch
  let call = 0
  globalThis.fetch = (async () => {
    const handler = handlers[call]
    call += 1
    if (!handler) throw new Error(`Unexpected extra fetch call #${call}`)
    return handler()
  }) as typeof fetch
  return { restore: () => { globalThis.fetch = originalFetch }, callCount: () => call }
}

function okRunsListResponse(runs: Array<{ id: number; displayTitle: string }>): Response {
  return new Response(
    JSON.stringify({
      workflow_runs: runs.map((r) => ({
        id: r.id,
        url: 'https://api.github.com/x',
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/x',
        head_branch: 'developer',
        head_sha: 'a'.repeat(40),
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:05:00Z',
        display_title: r.displayTitle,
      })),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

// Real, verified GitHub behavior (see Chat 06 hardening notes): a 403 with
// this exact message is GitHub's signature for a fine-grained PAT missing a
// required permission — must never be conflated with a generic failure.
test('triggerWorkflowBuild throws GithubPermissionError on a real 403 "Resource not accessible" response', async () => {
  const restore = mockFetchOnce(403, { message: 'Resource not accessible by personal access token' })
  try {
    await assert.rejects(
      () => triggerWorkflowBuild({ service: 'CMS', branch: 'developer', tag: 'latest' }),
      (error: unknown) => error instanceof GithubPermissionError,
    )
  } finally {
    restore()
  }
})

// Verified empirically: dispatching with a deliberately invalid ref against
// a token that DOES have Actions:Write returns 422 "No ref found" — this
// must be classified as a normal (non-permission) error, never mistaken for
// a 403.
test('triggerWorkflowBuild does NOT throw GithubPermissionError on a 422 (permission was fine, input was bad)', async () => {
  const restore = mockFetchOnce(422, { message: 'No ref found for: some-bad-ref' })
  try {
    await assert.rejects(
      () => triggerWorkflowBuild({ service: 'CMS', branch: 'some-bad-ref', tag: 'latest' }),
      (error: unknown) => error instanceof Error && !(error instanceof GithubPermissionError) && error.message.includes('422'),
    )
  } finally {
    restore()
  }
})

test('triggerWorkflowBuild resolves normally on the documented 200 dispatch response shape', async () => {
  const restore = mockFetchOnce(200, { workflow_run_id: 12345, run_url: 'https://api.github.com/x', html_url: 'https://github.com/x' })
  try {
    const result = await triggerWorkflowBuild({ service: 'CMS', branch: 'developer', tag: 'latest' })
    assert.equal(result.runId, 12345)
  } finally {
    restore()
  }
})

// ---- getCommitMessage ----

test('getCommitMessage returns only the first line (subject) of the full commit message', async () => {
  const restore = mockFetchOnce(200, { sha: 'a'.repeat(40), commit: { message: 'feat: implement SimpleSearchResidents feature\n\nLonger body text here.' } })
  try {
    const message = await getCommitMessage('a'.repeat(40))
    assert.equal(message, 'feat: implement SimpleSearchResidents feature')
  } finally {
    restore()
  }
})

test('getCommitMessage returns null when GitHub cannot find the commit (404) — never throws', async () => {
  const restore = mockFetchOnce(404, { message: 'Not Found' })
  try {
    const message = await getCommitMessage('a'.repeat(40))
    assert.equal(message, null)
  } finally {
    restore()
  }
})

test('getCommitMessage returns null on a permission error too — commit message is always best-effort', async () => {
  const restore = mockFetchOnce(403, { message: 'Resource not accessible by personal access token' })
  try {
    const message = await getCommitMessage('a'.repeat(40))
    assert.equal(message, null)
  } finally {
    restore()
  }
})

// ---- GET reliability: timeout/retry/rate-limit/classification (the actual
// production root cause — "[latestReleaseResolver] GitHub run scan failed",
// "GitHub API 500", "fetch failed") ----

test('a GET that 500s once then succeeds is retried automatically — the caller never sees the transient failure', async () => {
  const { restore, callCount } = mockFetchSequence([
    () => new Response('', { status: 500 }),
    () => okRunsListResponse([{ id: 42, displayTitle: 'Build CMS - latest' }]),
  ])
  try {
    const run = await findLatestGithubRunForService('CMS')
    assert.ok(run)
    assert.equal(run!.runId, 42)
    assert.equal(callCount(), 2, 'expected exactly one retry after the first 500')
  } finally {
    restore()
  }
})

test('a GET that fails at the network level (fetch throws) then succeeds recovers automatically', async () => {
  const { restore, callCount } = mockFetchSequence([
    () => {
      throw new TypeError('fetch failed')
    },
    () => okRunsListResponse([{ id: 7, displayTitle: 'Build WFO - latest' }]),
  ])
  try {
    const run = await findLatestGithubRunForService('WFO')
    assert.ok(run)
    assert.equal(run!.runId, 7)
    assert.equal(callCount(), 2)
  } finally {
    restore()
  }
})

test('a GET that keeps 500ing past the retry budget surfaces a GithubServerError, not a silent hang', async () => {
  const { restore } = mockFetchSequence([
    () => new Response('', { status: 500 }),
    () => new Response('', { status: 502 }),
    () => new Response('', { status: 503 }),
  ])
  try {
    await assert.rejects(
      () => getWorkflowRun(123),
      (error: unknown) => error instanceof GithubServerError,
    )
  } finally {
    restore()
  }
})

test('a 403 WITH rate-limit headers is classified as GithubRateLimitError, never GithubPermissionError', async () => {
  const { restore } = mockFetchSequence([
    () =>
      new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
        status: 403,
        headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '0', 'retry-after': '0' },
      }),
    () => okRunsListResponse([{ id: 9, displayTitle: 'Build CMS - latest' }]),
  ])
  try {
    const run = await findLatestGithubRunForService('CMS')
    assert.ok(run) // retried after the rate-limited 403 and succeeded
    assert.equal(run!.runId, 9)
  } finally {
    restore()
  }
})

test('a plain 403 with NO rate-limit headers is still classified as GithubPermissionError (no regression)', async () => {
  const { restore } = mockFetchSequence([() => new Response(JSON.stringify({ message: 'Resource not accessible by personal access token' }), { status: 403, headers: { 'content-type': 'application/json' } })])
  try {
    await assert.rejects(
      () => getWorkflowRun(1),
      (error: unknown) => error instanceof GithubPermissionError,
    )
  } finally {
    restore()
  }
})

test('a 429 is classified as GithubRateLimitError and retried', async () => {
  const { restore } = mockFetchSequence([
    () => new Response(JSON.stringify({ message: 'rate limited' }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' } }),
    () => okRunsListResponse([{ id: 11, displayTitle: 'Build CMS - latest' }]),
  ])
  try {
    const run = await findLatestGithubRunForService('CMS')
    assert.equal(run!.runId, 11)
  } finally {
    restore()
  }
})

test('a 401 is classified as GithubAuthError, distinct from GithubPermissionError', async () => {
  const { restore } = mockFetchSequence([() => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401, headers: { 'content-type': 'application/json' } })])
  try {
    await assert.rejects(
      () => getWorkflowRun(1),
      (error: unknown) => error instanceof GithubAuthError && !(error instanceof GithubPermissionError),
    )
  } finally {
    restore()
  }
})

test('triggerWorkflowBuild (dispatch POST) NEVER retries on a 500 — duplicate-dispatch safety', async () => {
  const { restore, callCount } = mockFetchSequence([() => new Response('', { status: 500 })])
  try {
    await assert.rejects(
      () => triggerWorkflowBuild({ service: 'CMS', branch: 'developer', tag: 'latest' }),
      (error: unknown) => error instanceof GithubServerError,
    )
    assert.equal(callCount(), 1, 'the dispatch POST must never be retried, even on a transient 5xx')
  } finally {
    restore()
  }
})

// ---- Caching: single-flight dedup + bounded cache + last-known-good fallback ----

test('concurrent discovery calls for different services share a single upstream workflow-runs request', async () => {
  let resolveFetch: (response: Response) => void = () => {}
  const deferred = new Promise<Response>((resolve) => {
    resolveFetch = resolve
  })
  const { restore, callCount } = mockFetchSequence([() => deferred])
  try {
    const callA = findLatestGithubRunForService('CMS')
    const callB = findLatestGithubRunForService('WFO')
    // Both calls started before the single in-flight request resolves.
    assert.equal(callCount(), 1, 'expected only ONE upstream fetch for two concurrent cache-miss callers')
    resolveFetch(
      okRunsListResponse([
        { id: 1, displayTitle: 'Build CMS - latest' },
        { id: 2, displayTitle: 'Build WFO - latest' },
      ]),
    )
    const [runA, runB] = await Promise.all([callA, callB])
    assert.equal(runA!.runId, 1)
    assert.equal(runB!.runId, 2)
    assert.equal(callCount(), 1)
  } finally {
    restore()
  }
})

test('a cached runs list is reused (no new fetch) within the cache window for a second service lookup', async () => {
  const { restore, callCount } = mockFetchSequence([() => okRunsListResponse([{ id: 5, displayTitle: 'Build CMS - latest' }])])
  try {
    await findLatestGithubRunForService('CMS')
    assert.equal(callCount(), 1)
    const again = await findLatestGithubRunForService('CMS')
    assert.equal(again!.runId, 5)
    assert.equal(callCount(), 1, 'expected the second lookup to reuse the cache, not issue a new request')
  } finally {
    restore()
  }
})

test('when the cache refresh fails, the last-known-good cache is served instead of throwing', async () => {
  const { restore } = mockFetchSequence([
    () => okRunsListResponse([{ id: 5, displayTitle: 'Build CMS - latest' }]),
    () => new Response('', { status: 500 }),
    () => new Response('', { status: 500 }),
    () => new Response('', { status: 500 }),
  ])
  try {
    const first = await findLatestGithubRunForService('CMS')
    assert.equal(first!.runId, 5)

    // Force a cache miss without waiting out the real 15s TTL.
    const originalNow = Date.now
    Date.now = () => originalNow() + 20_000
    try {
      const second = await findLatestGithubRunForService('CMS')
      // All 3 retry attempts on the refresh failed, but the stale cache from
      // the FIRST successful call (still in module state) is served instead
      // of throwing — this is the last-known-good fallback.
      assert.ok(second, 'expected the stale cache to be served, not a thrown error')
      assert.equal(second!.runId, 5)
    } finally {
      Date.now = originalNow
    }
  } finally {
    restore()
  }
})
