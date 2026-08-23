import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { callAgent } from '../../../../../lib/agent'
import { requireApiSession, errorResponse } from '../../../../../lib/api'
import { appendAudit } from '../../../../../lib/audit'
import { getEnvironment } from '../../../../../lib/config'
import { resolveAgentServiceCode } from '../../../../../lib/github/serviceMap'
import { isOperationLocked, releaseOperationLock, tryAcquireOperationLock } from '../../../../../lib/operationLock'
import { registerReleaseOperation } from '../../../../../lib/operationContext'
import { getReleaseRepository, planReleaseDeploy } from '../../../../../lib/releaseRepository'
import { normalizeServiceStatus, type RawServiceStatus } from '../../../../../lib/serviceStatus'
import type { OperationStartResponse, ReleaseDeployIntent, ReleaseDeployRequest, ReleaseDeployResponse } from '../../../../../lib/types'

function deployError(error: string, status: number, details?: string) {
  return NextResponse.json({ error, details }, { status })
}

const INTENT_LABEL: Record<ReleaseDeployIntent, string> = { redeploy: 'redeploy', rollback: 'rollback' }

/**
 * "Deploy lại release" and "rollback tới release cụ thể" are the same
 * underlying action: deploy THIS release's immutable repoDigest — never
 * re-resolved from "latest", never a client-supplied digest. The digest
 * always comes from the stored ReleaseSnapshot (loaded by id here), matching
 * exactly what Chat 01's Release Repository already guarantees is immutable.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession()
  if (session instanceof NextResponse) return session
  const { id } = await params

  let body: ReleaseDeployRequest
  try {
    body = await request.json()
  } catch {
    return deployError('invalid_request_body', 400, 'Request body must be JSON')
  }
  if (!body.environment) {
    return deployError('invalid_request_body', 400, 'environment is required')
  }
  const intent: ReleaseDeployIntent = body.intent === 'rollback' ? 'rollback' : 'redeploy'

  const release = await getReleaseRepository().getById(id)
  if (!release) {
    return deployError('release_not_found', 404)
  }

  // Structurally unreachable today (repoDigest is required and validated at
  // create() time — see releaseRepository.ts) but kept as an explicit,
  // user-facing guard per the "disable rollback if the snapshot has no
  // digest" requirement, in case that invariant is ever relaxed later.
  const earlyPlan = planReleaseDeploy(release, intent, undefined)
  if (!earlyPlan.ok && earlyPlan.reason === 'missing_digest') {
    return deployError('release_missing_digest', 409, 'This release has no immutable repoDigest recorded')
  }

  let environment
  try {
    environment = await getEnvironment(body.environment)
  } catch (error) {
    return deployError('invalid_environment', 400, error instanceof Error ? error.message : 'Unknown environment')
  }

  if (isOperationLocked(environment.code, release.service)) {
    return deployError(
      'operation_in_progress',
      409,
      `A deploy/rollback for ${release.service} on ${environment.code} is already in progress`,
    )
  }

  // The Deploy Agent's own service code (e.g. "o24-cms") is NOT the same
  // string as release.service (BuildServiceCode, e.g. "CMS") — the agent's
  // findService() does an exact, case-sensitive match against its
  // agent-config.json, so sending release.service directly always 404s
  // with "service_not_found" before any operation is even created (this
  // was exactly the 23:28 CMS failure: every redeploy/rollback through this
  // route failed here, never reaching runDeploy, hence no .env.deploy write
  // and no container recreate). Resolving it from the live /api/services
  // list — the same call already needed for fromRepoDigest — is the only
  // safe source: it's what the agent actually reports itself, not a
  // guessed naming convention.
  let fromRepoDigest: string | undefined
  let agentServiceCode: string
  try {
    const current = await callAgent<{ items: RawServiceStatus[] }>(environment, '/api/services')
    const matched = resolveAgentServiceCode(current.items.map(normalizeServiceStatus), release.service)
    if (!matched) {
      return deployError(
        'agent_service_not_found',
        502,
        `Deploy Agent on ${environment.code} does not report any service matching ${release.service}`,
      )
    }
    fromRepoDigest = matched.repoDigest
    agentServiceCode = matched.code
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[releases] failed to resolve Deploy Agent service code before deploy', {
      environment: environment.code,
      service: release.service,
      error: message,
    })
    // Unlike fromRepoDigest alone, this can no longer be best-effort: without
    // agentServiceCode we cannot know what to send as `service` to the agent
    // without guessing — and guessing is exactly the bug this fixes.
    return deployError('agent_unreachable', 502, message)
  }

  const plan = planReleaseDeploy(release, intent, fromRepoDigest)
  if (!plan.ok) {
    if (plan.reason === 'already_current') {
      return deployError('already_current', 409, `${release.service} on ${environment.code} is already running this digest`)
    }
    return deployError('release_missing_digest', 409, 'This release has no immutable repoDigest recorded')
  }
  const toRepoDigest = plan.toRepoDigest

  if (!tryAcquireOperationLock(environment.code, release.service)) {
    return deployError(
      'operation_in_progress',
      409,
      `A deploy/rollback for ${release.service} on ${environment.code} is already in progress`,
    )
  }

  try {
    const started = await callAgent<OperationStartResponse>(environment, '/api/deploy', {
      method: 'POST',
      timeoutMs: 30_000,
      body: {
        requestId: randomUUID(),
        service: agentServiceCode,
        digest: toRepoDigest,
        requestedBy: session.username,
        reason: `${INTENT_LABEL[intent]} release ${release.id}`,
      },
    })

    if (!started?.operationId) {
      releaseOperationLock(environment.code, release.service)
      await appendAudit({
        idempotencyKey: `release-${intent}:${release.id}:${environment.code}:${Date.now()}`,
        username: session.username,
        action: intent,
        environment: environment.code,
        service: release.service,
        digest: toRepoDigest,
        fromDigest: fromRepoDigest,
        toDigest: toRepoDigest,
        releaseId: release.id,
        status: 'failed',
        error: 'Deploy Agent did not return an operationId',
      })
      return deployError(
        'agent_response_invalid',
        502,
        'Deploy Agent did not return an operationId. Agent may be running an outdated build without async operation support.',
      )
    }

    registerReleaseOperation(started.operationId, {
      releaseId: release.id,
      service: release.service,
      environment: environment.code,
      action: intent,
      toRepoDigest,
      fromRepoDigest,
    })

    const response: ReleaseDeployResponse = {
      operationId: started.operationId,
      status: 'running',
      environment: environment.code,
      service: release.service,
      releaseId: release.id,
      fromRepoDigest,
      toRepoDigest,
      intent,
    }
    return NextResponse.json(response)
  } catch (error) {
    releaseOperationLock(environment.code, release.service)
    const message = error instanceof Error ? error.message : 'Unknown error'
    await appendAudit({
      idempotencyKey: `release-${intent}:${release.id}:${environment.code}:${Date.now()}`,
      username: session.username,
      action: intent,
      environment: environment.code,
      service: release.service,
      digest: toRepoDigest,
      fromDigest: fromRepoDigest,
      toDigest: toRepoDigest,
      releaseId: release.id,
      status: 'failed',
      error: message,
    })
    console.error('[releases] deploy dispatch failed', { releaseId: release.id, environment: environment.code, error: message })
    return deployError('trigger_failed', 502, message)
  }
}
