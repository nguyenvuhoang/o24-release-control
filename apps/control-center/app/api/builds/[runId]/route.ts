import { NextResponse } from 'next/server'
import { appendBuildAudit } from '../../../../lib/audit'
import { requireApiSession, errorResponse } from '../../../../lib/api'
import { getWorkflowRun } from '../../../../lib/github/client'
import { isBuildServiceCode } from '../../../../lib/github/serviceMap'
import { attemptSnapshotAndPersistPending } from '../../../../lib/snapshotReconciliation'

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

  let run
  try {
    // GitHub Actions is the authoritative source of build execution status —
    // only a failure to read it from GitHub itself is a genuine 502.
    run = await getWorkflowRun(numericRunId)
  } catch (error) {
    return errorResponse(error, 502)
  }

  // Everything below is best-effort enrichment — a durable-storage hiccup
  // here must never mask an otherwise-successful GitHub status read.
  try {
    await appendBuildAudit(run, service, session.username)
  } catch (auditError) {
    console.error('[builds/runId] appendBuildAudit failed', {
      service,
      runId: numericRunId,
      error: auditError instanceof Error ? auditError.message : 'Unknown error',
    })
  }
  if (service && isBuildServiceCode(service)) {
    try {
      // Poll route = fallback/reconciliation path (the webhook is
      // primary) — a single attempt is enough here since this route gets
      // hit repeatedly anyway; attemptSnapshotAndPersistPending also
      // hands off to the durable job queue on 'digest_not_found', same as
      // the webhook.
      await attemptSnapshotAndPersistPending(run, service, session.username)
    } catch (snapshotError) {
      // Best-effort, same non-blocking contract as appendBuildAudit above —
      // a snapshot-creation hiccup must never fail an otherwise-successful
      // status poll.
      console.error('[builds/runId] attemptSnapshotAndPersistPending failed', {
        service,
        runId: numericRunId,
        error: snapshotError instanceof Error ? snapshotError.message : 'Unknown error',
      })
    }
  }
  return NextResponse.json(run)
}
