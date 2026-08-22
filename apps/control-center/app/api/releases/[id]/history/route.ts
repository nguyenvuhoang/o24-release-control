import { NextResponse } from 'next/server'
import { requireApiSession, errorResponse } from '../../../../../lib/api'
import { getAuditRepository } from '../../../../../lib/auditRepository'
import { digestHexOf, getReleaseRepository } from '../../../../../lib/releaseRepository'
import type { ReleaseHistoryResponse } from '../../../../../lib/types'

// The audit trail has no releaseId/digest index (see auditRepository.ts —
// one global recency list, capped at 1000 records) so this reads that
// bounded, already-capped list and filters in memory. It is NOT a Redis
// scan: LRANGE + MGET on a fixed-size list is the same access pattern
// AuditLogPanel already uses. The tradeoff is real, though — a release whose
// last touch has aged out of that 1000-record window will show no history.
const HISTORY_SCAN_LIMIT = 500

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession()
  if (session instanceof NextResponse) return session
  const { id } = await params

  try {
    const release = await getReleaseRepository().getById(id)
    if (!release) {
      return NextResponse.json({ error: 'release_not_found' }, { status: 404 })
    }

    const digestHex = digestHexOf(release.repoDigest)
    const recent = await getAuditRepository().list(HISTORY_SCAN_LIMIT)
    const items = recent.filter((record) => {
      if (record.releaseId === id) return true
      if (record.service && record.service !== release.service) return false
      const candidates = [record.digest, record.fromDigest, record.toDigest]
      return candidates.some((value) => value && digestHexOf(value) === digestHex)
    })

    const response: ReleaseHistoryResponse = { releaseId: id, items }
    return NextResponse.json(response)
  } catch (error) {
    return errorResponse(error)
  }
}
