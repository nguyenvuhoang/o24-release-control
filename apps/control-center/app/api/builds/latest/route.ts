import { NextResponse, after } from 'next/server'
import { appendBuildAudit } from '../../../../lib/audit'
import { requireApiSession, errorResponse } from '../../../../lib/api'
import { getLastDispatchedRun } from '../../../../lib/buildPointerStore'
import { findLatestGithubRunForService, getWorkflowRun } from '../../../../lib/github/client'
import { BUILD_SERVICES, isBuildServiceCode } from '../../../../lib/github/serviceMap'
import { attemptSnapshotAndPersistPending } from '../../../../lib/snapshotReconciliation'
import type { LatestBuildResponse } from '../../../../lib/types'

// Server-side "what is the latest build for this service" lookup — the
// source of truth for build state (see useBuildTracker's hydrateFromServer),
// independent of the browser/device/localStorage that triggered the build:
// GitHub Actions itself is asked directly, every time.
export async function GET(request: Request) {
  const session = await requireApiSession()
  if (session instanceof NextResponse) return session

  const service = (new URL(request.url).searchParams.get('service') ?? '').trim().toUpperCase()
  if (!isBuildServiceCode(service)) {
    return NextResponse.json({ error: 'invalid_service', details: `service must be one of: ${BUILD_SERVICES.join(', ')}` }, { status: 400 })
  }

  // GitHub Actions is the authoritative source of build execution status —
  // a failure anywhere else (audit/snapshot persistence) must never turn a
  // successful GitHub read into a 502. Only a genuine failure to determine
  // the run itself (both the scan AND the known-run fallback failing) is
  // allowed to fail this request.
  let run
  try {
    run = await findLatestGithubRunForService(service)
  } catch (scanError) {
    // The scan throwing (GitHub 5xx/timeout/network) must fall back to a
    // known-dispatched run exactly like a clean "found nothing" does — this
    // was the direct cause of a transient GitHub hiccup immediately
    // surfacing as a 502 even when control-center itself dispatched (and
    // therefore already knows) this very run.
    console.error('[builds/latest] GitHub run scan failed — falling back to known dispatched run', {
      service,
      error: scanError instanceof Error ? scanError.message : 'Unknown error',
    })
    run = null
  }

  if (!run) {
    try {
      // Scan found nothing (or threw) — fall back to a run WE know we
      // dispatched for this service, if any, re-read live so its status is
      // still current.
      const knownRunId = await getLastDispatchedRun(service)
      if (knownRunId) run = await getWorkflowRun(knownRunId)
    } catch (fallbackError) {
      // Both paths to a run have now failed — this IS a genuine 502: there
      // is truly no way to answer "what is the latest build" right now.
      return errorResponse(fallbackError, 502)
    }
  }

  if (!run) {
    const empty: LatestBuildResponse = { service, runId: null }
    return NextResponse.json(empty)
  }

  // Whichever path found it, this may be the first time ANY client has
  // observed this run reach a terminal state (e.g. it was dispatched from
  // Telegram and nobody ever polled /api/builds/{runId} for it) — record
  // it now so the audit trail doesn't miss builds that didn't originate
  // in this app. Idempotent: harmless if the per-run poll route already
  // recorded the same runId+attempt. Best-effort AND non-blocking: a
  // durable-storage hiccup (or a hung Redis Gateway transport, see
  // docs/REDIS_GATEWAY.md) here must never mask, nor delay delivering, an
  // otherwise-successful GitHub status read — see app/api/builds/[runId]/
  // route.ts's identical after() comment for why this used to be awaited
  // before responding, and what that cost live tracking.
  after(async () => {
    try {
      await appendBuildAudit(run, service, session.username)
    } catch (auditError) {
      console.error('[builds/latest] appendBuildAudit failed', {
        service,
        runId: run.runId,
        error: auditError instanceof Error ? auditError.message : 'Unknown error',
      })
    }
    try {
      // Fallback/reconciliation path (the webhook is primary) — see
      // app/api/builds/[runId]/route.ts's identical comment.
      await attemptSnapshotAndPersistPending(run, service, session.username)
    } catch (snapshotError) {
      // Best-effort, same non-blocking contract as appendBuildAudit above.
      console.error('[builds/latest] attemptSnapshotAndPersistPending failed', {
        service,
        runId: run.runId,
        error: snapshotError instanceof Error ? snapshotError.message : 'Unknown error',
      })
    }
  })

  const response: LatestBuildResponse = { service, ...run }
  return NextResponse.json(response)
}
