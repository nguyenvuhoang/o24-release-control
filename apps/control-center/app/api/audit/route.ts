import { NextResponse } from 'next/server'
import { requireApiSession, errorResponse } from '../../../lib/api'
import { getAuditRepositoryStatus } from '../../../lib/auditRepository'

export async function GET(request: Request) {
  const session = await requireApiSession()
  if (session instanceof NextResponse) return session

  const { repository, configured } = getAuditRepositoryStatus()
  if (!configured) {
    // Deliberately NOT items: [] with a 200 — an empty list here would read
    // as "no operations have happened yet", which is false: this deployment
    // (Vercel, no KV) simply has nowhere durable to record them. The UI
    // (AuditLogPanel) checks this exact error code to show a distinct
    // "storage not configured" message instead of the empty-history one.
    return NextResponse.json(
      {
        error: 'audit_storage_not_configured',
        details:
          'Audit history storage is not configured for this deployment. Set KV_REST_API_URL/KV_REST_API_TOKEN ' +
          '(or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN) to enable durable audit history on Vercel.',
        items: [],
      },
      { status: 503 },
    )
  }

  try {
    const url = new URL(request.url)
    const limit = Number(url.searchParams.get('limit') ?? 30)
    return NextResponse.json({ items: await repository.list(limit) })
  } catch (error) {
    return errorResponse(error)
  }
}
