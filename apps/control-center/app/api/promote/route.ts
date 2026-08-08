import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { callAgent, waitForAgentOperation } from '../../../lib/agent'
import { requireApiSession, errorResponse } from '../../../lib/api'
import { appendAudit } from '../../../lib/audit'
import { loadControlConfig } from '../../../lib/config'
import type { OperationStartResponse, ServiceStatus } from '../../../lib/types'

export async function POST(request: Request) {
  const session = await requireApiSession()
  if (session instanceof NextResponse) return session
  const body = await request.json() as { sourceEnvironment?: string; targetEnvironment?: string; service?: string }
  if (!body.sourceEnvironment || !body.targetEnvironment || !body.service) {
    return NextResponse.json({ error: 'sourceEnvironment, targetEnvironment and service are required' }, { status: 400 })
  }
  try {
    const config = await loadControlConfig()
    const sourceIndex = config.environments.findIndex((item) => item.code === body.sourceEnvironment)
    const targetIndex = config.environments.findIndex((item) => item.code === body.targetEnvironment)
    if (sourceIndex < 0 || targetIndex !== sourceIndex + 1) {
      return NextResponse.json({ error: 'Only promotion to the next environment is allowed' }, { status: 400 })
    }
    const source = config.environments[sourceIndex]
    const target = config.environments[targetIndex]
    const sourceServices = await callAgent<{ items: ServiceStatus[] }>(source, '/api/services')
    const service = sourceServices.items.find((item) => item.code === body.service)
    if (!service?.digest) {
      throw new Error(`Source service ${body.service} does not expose an immutable digest`)
    }
    const started = await callAgent<OperationStartResponse>(target, '/api/deploy', {
      method: 'POST', timeoutMs: 30_000,
      body: {
        requestId: randomUUID(), service: body.service, digest: service.digest,
        requestedBy: session.username,
        reason: `promote ${source.code} -> ${target.code}`,
      },
    })
    const operation = await waitForAgentOperation(target, started.operationId, { timeoutMs: 10 * 60_000 })
    if (operation.status === 'failed') {
      throw new Error(operation.error || 'Deploy failed')
    }
    const result = operation
    await appendAudit({
      username: session.username, action: 'promote',
      sourceEnvironment: source.code, targetEnvironment: target.code,
      service: body.service, digest: service.digest, status: 'succeeded', details: result,
    })
    return NextResponse.json(result)
  } catch (error) {
    await appendAudit({
      username: session.username, action: 'promote',
      sourceEnvironment: body.sourceEnvironment, targetEnvironment: body.targetEnvironment,
      service: body.service, status: 'failed', error: error instanceof Error ? error.message : 'Unknown error',
    })
    return errorResponse(error, 502)
  }
}
