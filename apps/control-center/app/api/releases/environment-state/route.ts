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

    // Batched instead of one getByDigest call per environment: this used to
    // be up to 2*N Gateway/Upstash requests (2 per environment — digest
    // index + record) for a single POST, fired concurrently across all 7
    // services' own POSTs from the client — see docs/REDIS_GATEWAY.md's
    // root-cause note on Redis HTTP request concurrency during Dashboard
    // load. Now it's 2 requests total, regardless of how many environments
    // are asked about.
    const normalizedEnvironments = body.environments.map((entry) => ({
      code: entry.code,
      repoDigest: entry.repoDigest?.trim() || undefined,
    }))
    const lookupPairs = normalizedEnvironments
      .filter((entry): entry is { code: string; repoDigest: string } => Boolean(entry.repoDigest))
      .map((entry) => ({ service, repoDigest: entry.repoDigest }))
    const matched = await releaseRepository.getByDigests(lookupPairs).catch((error) => {
      console.error('[releases/environment-state] batched release digest lookup failed', {
        service,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      return lookupPairs.map(() => undefined)
    })

    let cursor = 0
    const items: ReleaseEnvironmentState[] = normalizedEnvironments.map((entry) => {
      if (!entry.repoDigest) return { environment: entry.code, repoDigest: undefined, release: null }
      const release = matched[cursor] ?? null
      cursor += 1
      return { environment: entry.code, repoDigest: entry.repoDigest, release }
    })

    const response: ReleaseEnvironmentStateResponse = { items }
    return NextResponse.json(response)
  } catch (error) {
    return errorResponse(error)
  }
}
