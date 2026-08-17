import { NextResponse } from 'next/server'
import { appendBuildAudit } from '../../../../lib/audit'
import { requireApiSession, errorResponse } from '../../../../lib/api'
import { getLastDispatchedRun } from '../../../../lib/buildPointerStore'
import { findLatestGithubRunForService, getWorkflowRun } from '../../../../lib/github/client'
import { BUILD_SERVICES, isBuildServiceCode } from '../../../../lib/github/serviceMap'
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

  try {
    let run = await findLatestGithubRunForService(service)
    if (!run) {
      // Scan found nothing (workflow's run-name/job names may not embed the
      // service) — fall back to a run WE know we dispatched for this
      // service, if any, re-read live so its status is still current.
      const knownRunId = await getLastDispatchedRun(service)
      if (knownRunId) run = await getWorkflowRun(knownRunId)
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
    // recorded the same runId+attempt.
    await appendBuildAudit(run, service, session.username)

    const response: LatestBuildResponse = { service, ...run }
    return NextResponse.json(response)
  } catch (error) {
    return errorResponse(error, 502)
  }
}
