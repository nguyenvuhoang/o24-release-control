import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchImageRevisionLabel } from './dockerHub'

const REPO = 'vknighthub/ips_o24cms'
const DIGEST = `sha256:${'a'.repeat(64)}`
const CONFIG_DIGEST = `sha256:${'b'.repeat(64)}`
const REVISION = 'c'.repeat(40)

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function mockFetchSequence(responses: Response[]) {
  const originalFetch = globalThis.fetch
  let call = 0
  globalThis.fetch = (async () => {
    const response = responses[call]
    call += 1
    if (!response) throw new Error(`Unexpected extra fetch call #${call}`)
    return response
  }) as typeof fetch
  return () => {
    globalThis.fetch = originalFetch
  }
}

test('fetchImageRevisionLabel reads org.opencontainers.image.revision through auth token → manifest → blob', async () => {
  const restore = mockFetchSequence([
    jsonResponse(200, { token: 'anon-token' }),
    jsonResponse(200, { mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { digest: CONFIG_DIGEST } }),
    jsonResponse(200, { config: { Labels: { 'org.opencontainers.image.revision': REVISION } } }),
  ])
  try {
    const revision = await fetchImageRevisionLabel(REPO, `${REPO}@${DIGEST}`)
    assert.equal(revision, REVISION)
  } finally {
    restore()
  }
})

test('fetchImageRevisionLabel descends into a multi-arch manifest list, preferring linux/amd64', async () => {
  const restore = mockFetchSequence([
    jsonResponse(200, { token: 'anon-token' }),
    jsonResponse(200, {
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [
        { digest: 'sha256:' + '1'.repeat(64), platform: { os: 'linux', architecture: 'arm64' } },
        { digest: 'sha256:' + '2'.repeat(64), platform: { os: 'linux', architecture: 'amd64' } },
      ],
    }),
    jsonResponse(200, { config: { digest: CONFIG_DIGEST } }),
    jsonResponse(200, { config: { Labels: { 'org.opencontainers.image.revision': REVISION } } }),
  ])
  try {
    const revision = await fetchImageRevisionLabel(REPO, `${REPO}@${DIGEST}`)
    assert.equal(revision, REVISION)
  } finally {
    restore()
  }
})

test('fetchImageRevisionLabel returns null when the image config has no revision label — never guesses', async () => {
  const restore = mockFetchSequence([
    jsonResponse(200, { token: 'anon-token' }),
    jsonResponse(200, { config: { digest: CONFIG_DIGEST } }),
    jsonResponse(200, { config: { Labels: { 'some.other.label': 'x' } } }),
  ])
  try {
    const revision = await fetchImageRevisionLabel(REPO, `${REPO}@${DIGEST}`)
    assert.equal(revision, null)
  } finally {
    restore()
  }
})

test('fetchImageRevisionLabel returns null when the anonymous token request fails', async () => {
  const restore = mockFetchSequence([jsonResponse(401, { error: 'unauthorized' })])
  try {
    const revision = await fetchImageRevisionLabel(REPO, `${REPO}@${DIGEST}`)
    assert.equal(revision, null)
  } finally {
    restore()
  }
})

test('fetchImageRevisionLabel returns null on a malformed repoDigest instead of throwing', async () => {
  const revision = await fetchImageRevisionLabel(REPO, 'not-a-digest')
  assert.equal(revision, null)
})

test('fetchImageRevisionLabel returns null (never throws) when the registry errors mid-flow', async () => {
  const restore = mockFetchSequence([
    jsonResponse(200, { token: 'anon-token' }),
    jsonResponse(500, { message: 'internal error' }),
  ])
  try {
    const revision = await fetchImageRevisionLabel(REPO, `${REPO}@${DIGEST}`)
    assert.equal(revision, null)
  } finally {
    restore()
  }
})
