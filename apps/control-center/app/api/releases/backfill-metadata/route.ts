import { NextResponse } from 'next/server'
import { requireApiSession, errorResponse } from '../../../../lib/api'
import { BUILD_SERVICES, isBuildServiceCode, type BuildServiceCode } from '../../../../lib/github/serviceMap'
import { backfillAllReleaseMetadata } from '../../../../lib/releaseMetadataBackfill'
import type { BackfillMetadataRequest, BackfillMetadataResponse } from '../../../../lib/types'

// Admin-triggered metadata enrichment for releases already on file — never
// creates a release, never touches artifact identity (repoDigest/tag/
// source/branch/runId/runAttempt/createdAt). Only fills commitSha/
// commitMessage where currently missing. Safe to call repeatedly: each call
// is bounded (see backfillAllReleaseMetadata's `limit`) and idempotent, so
// working through a large backlog is just clicking the button again.
export async function POST(request: Request) {
  const session = await requireApiSession()
  if (session instanceof NextResponse) return session

  let body: BackfillMetadataRequest = {}
  try {
    // An empty body ("backfill everything") is a valid, expected call —
    // only a genuinely malformed non-empty body is an error.
    const text = await request.text()
    if (text.trim()) body = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'invalid_request_body', details: 'Request body must be JSON' }, { status: 400 })
  }

  let service: BuildServiceCode | undefined
  if (body.service) {
    const normalized = body.service.trim().toUpperCase()
    if (!isBuildServiceCode(normalized)) {
      return NextResponse.json({ error: 'invalid_service', details: `service must be one of: ${BUILD_SERVICES.join(', ')}` }, { status: 400 })
    }
    service = normalized
  }

  try {
    const summary = await backfillAllReleaseMetadata({ service, limit: body.limit })
    const response: BackfillMetadataResponse = { success: true, ...summary }
    return NextResponse.json(response)
  } catch (error) {
    return errorResponse(error)
  }
}
