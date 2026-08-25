import assert from 'node:assert/strict'
import test from 'node:test'

process.env.GITHUB_TOKEN = 'test-token'
process.env.GITHUB_OWNER = 'test-owner'
process.env.GITHUB_REPO = 'test-repo'
process.env.GITHUB_WORKFLOW = 'build-o24.yml'

const { GithubPermissionError, getCommitMessage, triggerWorkflowBuild } = await import('./client')

function mockFetchOnce(status: number, body: unknown, headers: Record<string, string> = {}) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })) as typeof fetch
  return () => {
    globalThis.fetch = originalFetch
  }
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
