import { createHmac, timingSafeEqual } from 'node:crypto'
import path from 'node:path'

// Pure logic for the GitHub `workflow_run` webhook — kept separate from the
// route handler (app/api/webhooks/github/route.ts) so signature
// verification and payload filtering are directly unit-testable without a
// real HTTP request or a live GitHub delivery.

/**
 * Verifies GitHub's `X-Hub-Signature-256: sha256=<hex>` header against the
 * RAW request body (must be the exact bytes GitHub signed — never a
 * re-serialized/parsed-then-stringified version). Timing-safe. Returns
 * false for any malformed header, not just a genuine mismatch.
 */
export function verifyGithubWebhookSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false
  const provided = signatureHeader.slice('sha256='.length)
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')

  const providedBuffer = Buffer.from(provided, 'hex')
  const expectedBuffer = Buffer.from(expected, 'hex')
  if (providedBuffer.length !== expectedBuffer.length) return false
  return timingSafeEqual(providedBuffer, expectedBuffer)
}

export type GithubWorkflowRunWebhookPayload = {
  action: string
  workflow_run: {
    id: number
    path?: string
    run_attempt?: number
    head_branch: string
    head_sha: string
    status: string
    conclusion: string | null
    html_url: string
    created_at: string
    updated_at: string
  }
  workflow?: { path?: string }
  repository: { full_name: string }
}

export type WebhookFilterResult = { relevant: true } | { relevant: false; reason: string }

/**
 * Decides whether this delivery is one we act on at all: the right repo,
 * the right workflow file, and a `completed` workflow_run. Anything else is
 * acknowledged (200) by the route but intentionally skipped — never treated
 * as an error, so GitHub never disables the webhook over deliveries we
 * simply don't care about (e.g. `requested`/`in_progress` actions, or any
 * OTHER workflow in the same repo).
 */
export function filterWorkflowRunPayload(
  payload: GithubWorkflowRunWebhookPayload,
  expected: { ownerRepo: string; workflowFile: string },
): WebhookFilterResult {
  if (payload.repository?.full_name !== expected.ownerRepo) {
    return { relevant: false, reason: `repository ${payload.repository?.full_name} is not ${expected.ownerRepo}` }
  }
  const workflowPath = payload.workflow_run?.path ?? payload.workflow?.path ?? ''
  if (path.posix.basename(workflowPath) !== expected.workflowFile) {
    return { relevant: false, reason: `workflow ${workflowPath || '(unknown)'} is not ${expected.workflowFile}` }
  }
  if (payload.action !== 'completed') {
    return { relevant: false, reason: `action "${payload.action}" is not "completed"` }
  }
  return { relevant: true }
}
