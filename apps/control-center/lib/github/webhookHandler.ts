// The actual GitHub webhook handling logic — deliberately does NOT import
// 'next/server' (NextResponse), so it can be unit/integration-tested
// directly with node:test. app/api/webhooks/github/route.ts is a thin
// wrapper that only exists to bridge this to Next's Request/Response types
// (the same split already applied to lib/auth.ts/sessionCookies.ts and
// lib/api.ts/apiAccess.ts, for the identical reason: certain Next imports
// only resolve inside a Next.js/webpack build).
import { getBuildIntent } from '../buildPointerStore'
import { githubConfig } from './client'
import { isBuildServiceCode } from './serviceMap'
import { filterWorkflowRunPayload, verifyGithubWebhookSignature, type GithubWorkflowRunWebhookPayload } from './webhook'
import { createReleaseSnapshotWithRetry } from '../releaseSnapshotFromBuild'
import { getSnapshotJobStore, type SnapshotJobStore } from '../snapshotJobStore'
import type { BuildIntent, BuildRunSnapshot } from '../types'

export type WebhookHandlerResult = { status: number; body: Record<string, unknown> }

export type WebhookHandlerDeps = {
  getBuildIntent?: (runId: number) => Promise<BuildIntent | undefined>
  createReleaseSnapshotWithRetry?: typeof createReleaseSnapshotWithRetry
  snapshotJobStore?: SnapshotJobStore | null
}

export async function handleGithubWorkflowRunWebhook(
  rawBody: string,
  headers: { signature: string | null; event: string | null },
  deps: WebhookHandlerDeps = {},
): Promise<WebhookHandlerResult> {
  const lookupBuildIntent = deps.getBuildIntent ?? getBuildIntent
  const snapshotWithRetry = deps.createReleaseSnapshotWithRetry ?? createReleaseSnapshotWithRetry
  const jobStore = deps.snapshotJobStore !== undefined ? deps.snapshotJobStore : getSnapshotJobStore()

  const secret = process.env.GITHUB_WEBHOOK_SECRET
  if (!secret) {
    console.error('[webhooks/github] GITHUB_WEBHOOK_SECRET is not configured — refusing all deliveries')
    return { status: 500, body: { error: 'webhook_not_configured' } }
  }

  if (!verifyGithubWebhookSignature(rawBody, headers.signature, secret)) {
    console.error('[webhooks/github] signature verification failed')
    return { status: 401, body: { error: 'invalid_signature' } }
  }

  if (headers.event !== 'workflow_run') {
    // Acknowledged, not an error — other event types (e.g. "ping" on setup)
    // are expected and simply not acted on.
    return { status: 200, body: { status: 'ignored', reason: `event ${headers.event} is not workflow_run` } }
  }

  let payload: GithubWorkflowRunWebhookPayload
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return { status: 400, body: { error: 'invalid_json' } }
  }

  const { owner, repo, workflow } = githubConfig()
  const filterResult = filterWorkflowRunPayload(payload, { ownerRepo: `${owner}/${repo}`, workflowFile: workflow })
  if (!filterResult.relevant) {
    return { status: 200, body: { status: 'ignored', reason: filterResult.reason } }
  }

  const run = payload.workflow_run
  const runSnapshot: BuildRunSnapshot = {
    runId: run.id,
    status: run.status as BuildRunSnapshot['status'],
    conclusion: run.conclusion as BuildRunSnapshot['conclusion'],
    htmlUrl: run.html_url,
    branch: run.head_branch,
    commitSha: run.head_sha,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    runAttempt: run.run_attempt,
  }

  if (runSnapshot.conclusion !== 'success') {
    return { status: 200, body: { status: 'acknowledged', outcome: 'not_eligible', runId: run.id } }
  }

  const intent = await lookupBuildIntent(run.id).catch(() => undefined)
  if (!intent || !isBuildServiceCode(intent.service)) {
    console.error('[webhooks/github] no BuildIntent found for this run — cannot resolve service, skipping', { runId: run.id })
    return { status: 200, body: { status: 'acknowledged', outcome: 'unresolved_service', runId: run.id } }
  }

  try {
    const outcome = await snapshotWithRetry(runSnapshot, intent.service, 'github-webhook')

    if (outcome.outcome === 'digest_not_found') {
      // Immediate retries (2s/4s/8s) are exhausted, but the build's
      // lifecycle is NOT over — hand off to the durable, cron-driven
      // reconciliation queue instead of dropping it. This is the fix for
      // "hết retry mà digest chưa sẵn sàng thì không được bỏ BuildIntent
      // hoặc xem lifecycle đã hoàn tất".
      if (jobStore) {
        await jobStore.upsertPending({
          service: intent.service,
          runId: runSnapshot.runId,
          runAttempt: runSnapshot.runAttempt ?? 1,
          branch: runSnapshot.branch,
          commitSha: runSnapshot.commitSha,
          htmlUrl: runSnapshot.htmlUrl,
          createdBySource: 'github-webhook',
        })
      } else {
        console.error('[webhooks/github] digest not found and no Redis configured — this build will NOT be durably reconciled', {
          runId: run.id,
          service: intent.service,
        })
      }
    }

    return { status: 200, body: { status: 'acknowledged', outcome: outcome.outcome, runId: run.id, service: intent.service } }
  } catch (error) {
    console.error('[webhooks/github] createReleaseSnapshotWithRetry failed', {
      runId: run.id,
      service: intent.service,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    // A genuine internal error (not a "not ready yet") — 500 lets GitHub's
    // own webhook redelivery mechanism retry this later, on top of the
    // in-request retry already attempted above.
    return { status: 500, body: { error: 'internal_error' } }
  }
}
