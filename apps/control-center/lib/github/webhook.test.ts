import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac } from 'node:crypto'
import { filterWorkflowRunPayload, verifyGithubWebhookSignature, type GithubWorkflowRunWebhookPayload } from './webhook'

const SECRET = 'test-webhook-secret'

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

// ---- verifyGithubWebhookSignature ----

test('accepts a correctly signed body', () => {
  const body = '{"hello":"world"}'
  assert.equal(verifyGithubWebhookSignature(body, sign(body), SECRET), true)
})

test('rejects a body that was tampered with after signing', () => {
  const body = '{"hello":"world"}'
  const signature = sign(body)
  assert.equal(verifyGithubWebhookSignature('{"hello":"WORLD"}', signature, SECRET), false)
})

test('rejects a signature produced with the wrong secret', () => {
  const body = '{"hello":"world"}'
  assert.equal(verifyGithubWebhookSignature(body, sign(body, 'wrong-secret'), SECRET), false)
})

test('rejects a missing signature header', () => {
  assert.equal(verifyGithubWebhookSignature('{}', null, SECRET), false)
})

test('rejects a malformed signature header (no "sha256=" prefix)', () => {
  assert.equal(verifyGithubWebhookSignature('{}', 'deadbeef', SECRET), false)
})

// ---- filterWorkflowRunPayload ----

function makePayload(overrides: Partial<GithubWorkflowRunWebhookPayload> = {}): GithubWorkflowRunWebhookPayload {
  return {
    action: 'completed',
    workflow_run: {
      id: 123,
      path: '.github/workflows/build-o24.yml',
      run_attempt: 1,
      head_branch: 'developer',
      head_sha: 'a'.repeat(40),
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://github.com/nguyenvuhoang/w4s/actions/runs/123',
      created_at: '2026-08-23T00:00:00Z',
      updated_at: '2026-08-23T00:05:00Z',
    },
    repository: { full_name: 'nguyenvuhoang/w4s' },
    ...overrides,
  }
}

const EXPECTED = { ownerRepo: 'nguyenvuhoang/w4s', workflowFile: 'build-o24.yml' }

test('a real completed build-o24.yml run on the right repo is relevant', () => {
  assert.deepEqual(filterWorkflowRunPayload(makePayload(), EXPECTED), { relevant: true })
})

test('a different repository is filtered out', () => {
  const result = filterWorkflowRunPayload(makePayload({ repository: { full_name: 'someone-else/other-repo' } }), EXPECTED)
  assert.equal(result.relevant, false)
})

test('a different workflow file in the same repo is filtered out', () => {
  const payload = makePayload()
  payload.workflow_run.path = '.github/workflows/other-workflow.yml'
  const result = filterWorkflowRunPayload(payload, EXPECTED)
  assert.equal(result.relevant, false)
})

test('a non-"completed" action (e.g. "in_progress") is filtered out', () => {
  const result = filterWorkflowRunPayload(makePayload({ action: 'in_progress' }), EXPECTED)
  assert.equal(result.relevant, false)
})

test('falls back to the top-level workflow.path when workflow_run.path is absent', () => {
  const payload = makePayload()
  delete payload.workflow_run.path
  payload.workflow = { path: '.github/workflows/build-o24.yml' }
  assert.deepEqual(filterWorkflowRunPayload(payload, EXPECTED), { relevant: true })
})
