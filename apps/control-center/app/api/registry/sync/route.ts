import { NextResponse } from 'next/server'
import { requireApiSession } from '../../../../lib/api'
import { appendAudit } from '../../../../lib/audit'
import { fetchDockerHubTagDigest } from '../../../../lib/dockerHub'
import { BUILD_SERVICES, imageRepositoryFor, isBuildServiceCode } from '../../../../lib/github/serviceMap'
import { digestHexOf, getReleaseRepository, InvalidReleaseInputError, ReleaseConflictError } from '../../../../lib/releaseRepository'
import type { RegistrySyncResponse } from '../../../../lib/types'

function syncError(error: string, status: number, details?: string) {
  return NextResponse.json({ success: false, error, details }, { status })
}

// Imports whatever is CURRENTLY on Docker Hub's "latest" tag as a Release
// Snapshot — it never triggers a build. This is the only way a registry
// (Telegram/DEV-server-pushed) image ever becomes visible to Release
// Control as something deployable: comparisons and promotions only ever
// trust a ReleaseSnapshot's repoDigest, never Docker Hub or localStorage
// directly.
export async function POST(request: Request) {
  const session = await requireApiSession()
  if (session instanceof NextResponse) return session

  let body: { service?: string }
  try {
    body = await request.json()
  } catch {
    return syncError('invalid_request_body', 400, 'Request body must be JSON')
  }

  const service = (body.service ?? '').trim().toUpperCase()
  if (!isBuildServiceCode(service)) {
    return syncError('invalid_service', 400, `service must be one of: ${BUILD_SERVICES.join(', ')}`)
  }

  try {
    const dockerRepository = imageRepositoryFor(service)
    const dockerHub = await fetchDockerHubTagDigest(dockerRepository)
    if (!dockerHub) {
      return syncError('not_found', 404, `No "latest" tag found on Docker Hub for ${dockerRepository}`)
    }

    const { record, deduped } = await getReleaseRepository().create({
      service,
      source: 'docker-registry',
      dockerRepository,
      repoDigest: dockerHub.repoDigest,
      tag: dockerHub.tag,
      createdBy: session.username,
      discoveredAt: new Date().toISOString(),
    })

    // Only a genuinely NEW record is an auditable event — re-syncing an
    // already-known digest (deduped) changed nothing, so it would just spam
    // the trail with identical rows on every repeat click.
    if (!deduped) {
      const digestHex = digestHexOf(record.repoDigest)
      await appendAudit({
        idempotencyKey: `registry-import:${record.id}`,
        username: session.username,
        action: 'import',
        service,
        digest: digestHex ? `sha256:${digestHex}` : undefined,
        toDigest: digestHex ? `sha256:${digestHex}` : undefined,
        releaseId: record.id,
        status: 'succeeded',
        details: { dockerRepository, tag: record.tag },
      })
    }

    const response: RegistrySyncResponse = { success: true, release: record, deduped }
    return NextResponse.json(response)
  } catch (error) {
    if (error instanceof ReleaseConflictError) {
      await appendAudit({
        idempotencyKey: `registry-import-conflict:${error.releaseId}:${Date.now()}`,
        username: session.username,
        action: 'import',
        service,
        releaseId: error.releaseId,
        status: 'failed',
        error: error.message,
      })
      return syncError('release_conflict', 409, error.message)
    }
    if (error instanceof InvalidReleaseInputError) {
      return syncError('invalid_release', 400, error.message)
    }
    console.error('[registry] sync failed', { service, error: error instanceof Error ? error.message : 'Unknown error' })
    await appendAudit({
      idempotencyKey: `registry-import-failed:${service}:${Date.now()}`,
      username: session.username,
      action: 'import',
      service,
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return syncError('sync_failed', 502, error instanceof Error ? error.message : 'Unknown error')
  }
}
