import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { callAgent } from '../../../lib/agent'
import { requireApiSession, errorResponse } from '../../../lib/api'
import { getEnvironment } from '../../../lib/config'
import type { OperationStartResponse } from '../../../lib/types'

export async function POST(request: Request) {
  const session = await requireApiSession()
  if (session instanceof NextResponse) return session
  const body = await request.json() as { environment?: string; service?: string; digest?: string; reason?: string }
  if (!body.environment || !body.service || !body.digest) {
    return NextResponse.json({ error: 'environment, service and digest are required' }, { status: 400 })
  }
  try {
    const environment = await getEnvironment(body.environment)
    const started = await callAgent<OperationStartResponse>(environment, '/api/deploy', {
      method: 'POST',
      timeoutMs: 30_000,
      body: {
        requestId: randomUUID(),
        service: body.service,
        digest: body.digest,
        requestedBy: session.username,
        reason: body.reason ?? 'manual deploy',
      },
    })
    return NextResponse.json({
      operationId: started.operationId,
      status: started.status,
      environment: body.environment,
      service: body.service,
      action: 'deploy',
    })
  } catch (error) {
    return errorResponse(error, 502)
  }
}
