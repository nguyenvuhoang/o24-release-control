import { NextResponse } from 'next/server'
import { requireApiSession, errorResponse } from '../../../lib/api'
import { isBuildServiceCode, BUILD_SERVICES } from '../../../lib/github/serviceMap'
import { getReleaseRepository, type ListReleasesQuery } from '../../../lib/releaseRepository'
import type { ReleaseSource, ReleaseTimelineResponse } from '../../../lib/types'

const SOURCES: ReleaseSource[] = ['github-actions', 'docker-registry']

function isReleaseSource(value: string): value is ReleaseSource {
  return (SOURCES as string[]).includes(value)
}

// Version Timeline for one service — GET /api/releases?service=CMS. See
// ListReleasesQuery in releaseRepository.ts for how branch/source/since/until
// interact with pagination (applied within the fetched page, not pre-filtered
// by the index).
export async function GET(request: Request) {
  const session = await requireApiSession()
  if (session instanceof NextResponse) return session

  const url = new URL(request.url)
  const serviceParam = (url.searchParams.get('service') ?? '').trim().toUpperCase()
  if (!isBuildServiceCode(serviceParam)) {
    return NextResponse.json({ error: 'invalid_service', details: `service must be one of: ${BUILD_SERVICES.join(', ')}` }, { status: 400 })
  }

  const query: ListReleasesQuery = { service: serviceParam }

  const branch = url.searchParams.get('branch')
  if (branch) query.branch = branch

  const source = url.searchParams.get('source')
  if (source) {
    if (!isReleaseSource(source)) {
      return NextResponse.json({ error: 'invalid_source', details: `source must be one of: ${SOURCES.join(', ')}` }, { status: 400 })
    }
    query.source = source
  }

  const since = url.searchParams.get('since')
  if (since) query.since = since
  const until = url.searchParams.get('until')
  if (until) query.until = until

  const limitParam = url.searchParams.get('limit')
  if (limitParam) {
    const limit = Number(limitParam)
    if (!Number.isFinite(limit)) {
      return NextResponse.json({ error: 'invalid_limit' }, { status: 400 })
    }
    query.limit = limit
  }

  const cursor = url.searchParams.get('cursor')
  if (cursor) query.cursor = cursor

  try {
    const { items, nextCursor } = await getReleaseRepository().list(query)
    const response: ReleaseTimelineResponse = { items, nextCursor }
    return NextResponse.json(response)
  } catch (error) {
    return errorResponse(error)
  }
}
