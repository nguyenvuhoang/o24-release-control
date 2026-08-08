import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { callAgent } from '../../../lib/agent'
import { requireApiSession } from '../../../lib/api'
import { loadControlConfig } from '../../../lib/config'
import { registerPromoteOperation } from '../../../lib/operationContext'
import type { OperationStartResponse, ServiceStatus } from '../../../lib/types'

function promoteError(error: string, status: number, details?: string) {
  return NextResponse.json({ success: false, error, details }, { status })
}

export async function POST(request: Request) {
  const session = await requireApiSession()
  if (session instanceof NextResponse) return session

  let body: { sourceEnvironment?: string; targetEnvironment?: string; service?: string }
  try {
    body = await request.json()
  } catch {
    return promoteError('invalid_request_body', 400, 'Request body must be JSON')
  }
  if (!body.sourceEnvironment || !body.targetEnvironment || !body.service) {
    return promoteError('sourceEnvironment, targetEnvironment and service are required', 400)
  }

  try {
    const config = await loadControlConfig()
    const sourceIndex = config.environments.findIndex((item) => item.code === body.sourceEnvironment)
    const targetIndex = config.environments.findIndex((item) => item.code === body.targetEnvironment)
    if (sourceIndex < 0 || targetIndex !== sourceIndex + 1) {
      return promoteError('Only promotion to the next environment is allowed', 400)
    }
    const source = config.environments[sourceIndex]
    const target = config.environments[targetIndex]

    const sourceServices = await callAgent<{ items: ServiceStatus[] }>(source, '/api/services')
    const service = sourceServices.items.find((item) => item.code === body.service)
    if (!service?.digest) {
      return promoteError(`Source service ${body.service} does not expose an immutable digest`, 409)
    }

    const started = await callAgent<OperationStartResponse>(target, '/api/deploy', {
      method: 'POST',
      timeoutMs: 30_000,
      body: {
        requestId: randomUUID(),
        service: body.service,
        digest: service.digest,
        requestedBy: session.username,
        reason: `promote ${source.code} -> ${target.code}`,
      },
    })

    if (!started?.operationId) {
      console.error('[promote] agent response missing operationId', {
        upstreamStatus: 200,
        targetEnvironment: target.code,
        service: body.service,
        path: '/api/deploy',
      })
      return promoteError(
        'Deploy Agent did not return an operationId',
        502,
        'Agent may be running an outdated build without async operation support.',
      )
    }

    registerPromoteOperation(started.operationId, {
      sourceEnvironment: source.code,
      targetEnvironment: target.code,
    })

    return NextResponse.json({
      success: true,
      operationId: started.operationId,
      sourceEnvironment: source.code,
      targetEnvironment: target.code,
      service: body.service,
      image: service.image,
      digest: service.digest,
    })
  } catch (error) {
    return promoteError(
      'request_failed',
      502,
      error instanceof Error ? error.message : 'Unknown error',
    )
  }
}
