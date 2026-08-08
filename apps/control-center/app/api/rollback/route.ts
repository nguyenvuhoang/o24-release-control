import { NextResponse } from 'next/server'
import { callAgent } from '../../../lib/agent'
import { requireApiSession, errorResponse } from '../../../lib/api'
import { getEnvironment } from '../../../lib/config'
import type { OperationStartResponse } from '../../../lib/types'

export async function POST(request: Request) {
  const session = await requireApiSession()
  if (session instanceof NextResponse) return session
  const body = await request.json() as { environment?: string; service?: string }
  if (!body.environment || !body.service) {
    return NextResponse.json({ error: 'environment and service are required' }, { status: 400 })
  }
  try {
    const environment = await getEnvironment(body.environment)
    const started = await callAgent<OperationStartResponse>(environment, `/api/services/${encodeURIComponent(body.service)}/rollback`, {
      method: 'POST', body: {}, timeoutMs: 30_000,
    })
    return NextResponse.json({
      operationId: started.operationId,
      status: started.status,
      environment: body.environment,
      service: body.service,
      action: 'rollback',
    })
  } catch (error) {
    return errorResponse(error, 502)
  }
}
