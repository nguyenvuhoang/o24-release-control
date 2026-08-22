import { NextResponse } from 'next/server'
import { requireApiSession, errorResponse } from '../../../../lib/api'
import { isBuildServiceCode, BUILD_SERVICES } from '../../../../lib/github/serviceMap'
import { getReleaseRepository } from '../../../../lib/releaseRepository'
import type { ReleaseEnvironmentState, ReleaseEnvironmentStateRequest, ReleaseEnvironmentStateResponse } from '../../../../lib/types'

// Resolves "which Release Snapshot is currently running in each
// environment" for one service, mapping service+environment -> snapshot as
// required by the Version Timeline's running-environment badges. The client
// supplies each environment's LIVE repoDigest (already fresh off
// /api/dashboard, which itself reads it straight from the Deploy Agent) —
// this endpoint only resolves it against the digest index, it never uses the
// digest for anything but a read, so trusting the client-supplied value here
// is safe (contrast with /api/releases/[id]/deploy, which never trusts a
// client digest for an actual deploy).
export async function POST(request: Request) {
  const session = await requireApiSession()
  if (session instanceof NextResponse) return session

  let body: ReleaseEnvironmentStateRequest
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_request_body', details: 'Request body must be JSON' }, { status: 400 })
  }

  const service = (body.service ?? '').trim().toUpperCase()
  if (!isBuildServiceCode(service)) {
    return NextResponse.json({ error: 'invalid_service', details: `service must be one of: ${BUILD_SERVICES.join(', ')}` }, { status: 400 })
  }
  if (!Array.isArray(body.environments)) {
    return NextResponse.json({ error: 'invalid_request_body', details: 'environments must be an array' }, { status: 400 })
  }

  try {
    const releaseRepository = getReleaseRepository()
    const items: ReleaseEnvironmentState[] = await Promise.all(
      body.environments.map(async (entry) => {
        const repoDigest = entry.repoDigest?.trim() || undefined
        const release = repoDigest ? (await releaseRepository.getByDigest(service, repoDigest)) ?? null : null
        return { environment: entry.code, repoDigest, release }
      }),
    )
    const response: ReleaseEnvironmentStateResponse = { items }
    return NextResponse.json(response)
  } catch (error) {
    return errorResponse(error)
  }
}
