import { NextResponse } from 'next/server'
import { callAgent } from '../../../../lib/agent'
import { requireApiSession, errorResponse } from '../../../../lib/api'
import { appendAudit } from '../../../../lib/audit'
import { getEnvironment } from '../../../../lib/config'
import { getPromoteContext } from '../../../../lib/operationContext'
import type { OperationSnapshot } from '../../../../lib/types'

// Tracks operations whose terminal outcome has already been written to the
// audit log, so re-fetching status after a reload never double-records it.
// Reset on process restart; the agent's own deployments.jsonl remains the
// durable source of truth for deploy history either way.
const auditedOperations = new Set<string>()

export async function GET(request: Request, { params }: { params: Promise<{ operationId: string }> }) {
  const session = await requireApiSession()
  if (session instanceof NextResponse) return session
  const { operationId } = await params
  const url = new URL(request.url)
  const environmentCode = url.searchParams.get('environment')
  if (!environmentCode) {
    return NextResponse.json({ error: 'environment is required' }, { status: 400 })
  }
  try {
    const environment = await getEnvironment(environmentCode)
    const snapshot = await callAgent<OperationSnapshot>(environment, `/api/operations/${encodeURIComponent(operationId)}`)

    if (snapshot.status !== 'running' && !auditedOperations.has(operationId)) {
      auditedOperations.add(operationId)
      const digest = snapshot.image?.includes('@sha256:') ? snapshot.image.split('@sha256:')[1] : undefined
      const promoteContext = getPromoteContext(operationId)
      await appendAudit({
        username: session.username,
        action: promoteContext ? 'promote' : snapshot.action,
        environment: promoteContext ? undefined : snapshot.environment,
        sourceEnvironment: promoteContext?.sourceEnvironment,
        targetEnvironment: promoteContext?.targetEnvironment,
        service: snapshot.service,
        digest: digest ? `sha256:${digest}` : undefined,
        status: snapshot.status === 'success' ? 'succeeded' : 'failed',
        error: snapshot.error,
        details: { operationId: snapshot.operationId, startedAt: snapshot.startedAt, completedAt: snapshot.completedAt },
      })
    }

    return NextResponse.json(snapshot)
  } catch (error) {
    return errorResponse(error, 502)
  }
}
