import { NextResponse } from 'next/server'
import { appendAudit } from '../../../../lib/audit'
import { requireApiSession, errorResponse } from '../../../../lib/api'
import { getWorkflowRun } from '../../../../lib/github/client'

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const session = await requireApiSession()
  if (session instanceof NextResponse) return session

  const { runId } = await params
  const numericRunId = Number(runId)
  if (!Number.isInteger(numericRunId) || numericRunId <= 0) {
    return NextResponse.json({ error: 'invalid runId' }, { status: 400 })
  }
  // The client (useBuildTracker) is the source of truth for which service
  // triggered this run — GitHub's run API doesn't echo back the
  // workflow_dispatch `service` input, only the branch/commit.
  const service = new URL(request.url).searchParams.get('service') ?? undefined

  try {
    const run = await getWorkflowRun(numericRunId)
    if (run.status === 'completed') {
      // idempotencyKey includes runAttempt (not just runId): a GitHub
      // "Re-run failed jobs" keeps the same runId but bumps run_attempt, and
      // that retry deserves its own audit row (e.g. attempt 1 failed, attempt
      // 2 succeeded) rather than being silently deduped against attempt 1's
      // outcome. Within a single attempt, repeated polls that all observe
      // "completed" still write at most once, since the key is unchanged.
      await appendAudit({
        idempotencyKey: `build:${numericRunId}:${run.runAttempt ?? 1}`,
        username: session.username,
        action: 'build',
        service,
        status: run.conclusion === 'success' ? 'succeeded' : 'failed',
        error: run.conclusion && run.conclusion !== 'success' ? `Build conclusion: ${run.conclusion}` : undefined,
        details: { runId: run.runId, runAttempt: run.runAttempt, branch: run.branch, commitSha: run.commitSha, htmlUrl: run.htmlUrl },
      })
    }
    return NextResponse.json(run)
  } catch (error) {
    return errorResponse(error, 502)
  }
}
