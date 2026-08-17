import { NextResponse } from 'next/server'
import { callAgent } from '../../../../lib/agent'
import { requireApiSession, errorResponse } from '../../../../lib/api'
import { appendAudit } from '../../../../lib/audit'
import { getEnvironment } from '../../../../lib/config'
import { getPromoteContext } from '../../../../lib/operationContext'
import type { OperationSnapshot } from '../../../../lib/types'

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

    if (snapshot.status !== 'running') {
      const digest = snapshot.image?.includes('@sha256:') ? snapshot.image.split('@sha256:')[1] : undefined
      const promoteContext = getPromoteContext(operationId)
      // idempotencyKey (not a random id) so repeated calls for the same
      // operation — an SSE reconnect re-hitting this route, or
      // settleOperation()'s fallback fetch racing the stream's own terminal
      // event — write the same audit record at most once, enforced by the
      // repository rather than by in-process state (which wouldn't survive
      // a serverless cold start or a second instance).
      await appendAudit({
        idempotencyKey: `operation:${operationId}`,
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
