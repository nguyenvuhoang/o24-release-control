import { NextResponse } from 'next/server'
import { requireApiSession } from '../../../lib/api'
import { recordDispatchedRun } from '../../../lib/buildPointerStore'
import { getConfiguredBuildBranch, triggerWorkflowBuild } from '../../../lib/github/client'
import { isDispatchLocked, markDispatched } from '../../../lib/github/dispatchLock'
import { isBuildServiceCode, BUILD_SERVICES } from '../../../lib/github/serviceMap'
import type { BuildTriggerResponse } from '../../../lib/types'

// Docker tags may contain letters, digits, dots, underscores and hyphens
// (mirrors Docker's own tag grammar), capped to a sane length.
const TAG_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

function buildError(error: string, status: number, details?: string) {
  return NextResponse.json({ success: false, error, details }, { status })
}

export async function POST(request: Request) {
  const session = await requireApiSession()
  if (session instanceof NextResponse) return session

  let body: { service?: string; branch?: string; tag?: string }
  try {
    body = await request.json()
  } catch {
    return buildError('invalid_request_body', 400, 'Request body must be JSON')
  }

  const service = (body.service ?? '').trim().toUpperCase()
  if (!isBuildServiceCode(service)) {
    return buildError('invalid_service', 400, `service must be one of: ${BUILD_SERVICES.join(', ')}`)
  }

  const configuredBranch = getConfiguredBuildBranch()
  const branch = (body.branch ?? configuredBranch).trim()
  if (branch !== configuredBranch) {
    return buildError('invalid_branch', 400, `branch must be ${configuredBranch}`)
  }

  const tag = (body.tag ?? '').trim() || 'latest'
  if (!TAG_PATTERN.test(tag)) {
    return buildError('invalid_tag', 400, 'tag may only contain letters, digits, dots, underscores and hyphens')
  }

  if (isDispatchLocked(service)) {
    return buildError('too_many_requests', 429, `A build for ${service} was just triggered. Please wait a moment before retrying.`)
  }
  markDispatched(service)

  try {
    const run = await triggerWorkflowBuild({ service, branch, tag })
    try {
      // Best-effort hint for /api/builds/latest's fallback path — never let
      // a storage hiccup here fail an otherwise-successful dispatch.
      await recordDispatchedRun(service, run.runId)
    } catch (pointerError) {
      console.error('[builds] recordDispatchedRun failed', {
        service,
        runId: run.runId,
        error: pointerError instanceof Error ? pointerError.message : 'Unknown error',
      })
    }
    const response: BuildTriggerResponse = {
      success: true,
      service,
      tag,
      branch,
      runId: run.runId,
      runUrl: run.runUrl,
      htmlUrl: run.htmlUrl,
    }
    return NextResponse.json(response)
  } catch (error) {
    console.error('[builds] trigger failed', {
      service,
      branch,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return buildError('trigger_failed', 502, error instanceof Error ? error.message : 'Unknown error')
  }
}
