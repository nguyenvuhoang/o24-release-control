import { NextResponse } from 'next/server'
import { resolveAffectedServices } from '../../../../lib/affectedServices/resolver'
import { requireApiSession } from '../../../../lib/api'
import { appendAudit } from '../../../../lib/audit'
import { getConfiguredBuildBranch } from '../../../../lib/github/client'
import { CompareNotFoundError, CompareRateLimitedError, compareCommits } from '../../../../lib/github/compare'
import { fetchDependencyGraph } from '../../../../lib/github/w4sGraph'
import type { AffectedServicesRequest, AffectedServicesResponse } from '../../../../lib/types'

// Branch names and commit SHAs only — this is interpolated into a GitHub
// API URL path (see compareCommits), so anything wider than this is
// rejected rather than passed through.
const REF_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/

function buildError(error: string, status: number, details?: string) {
  return NextResponse.json({ success: false, error, details }, { status })
}

export async function POST(request: Request) {
  const session = await requireApiSession()
  if (session instanceof NextResponse) return session

  let body: AffectedServicesRequest
  try {
    body = await request.json()
  } catch {
    return buildError('invalid_request_body', 400, 'Request body must be JSON')
  }

  const base = (body.base ?? '').trim()
  const head = (body.head ?? '').trim() || getConfiguredBuildBranch()

  if (!REF_PATTERN.test(base)) {
    return buildError('invalid_request', 400, 'base phải là tên branch hoặc commit SHA hợp lệ')
  }
  if (!REF_PATTERN.test(head)) {
    return buildError('invalid_request', 400, 'head phải là tên branch hoặc commit SHA hợp lệ')
  }

  try {
    const compare = await compareCommits(base, head)

    let graph = null
    let graphError: string | undefined
    try {
      graph = await fetchDependencyGraph(head)
    } catch (error) {
      graphError = error instanceof Error ? error.message : 'Unknown error'
      console.error('[builds/affected-services] fetchDependencyGraph failed', { head, error: graphError })
    }

    const result = resolveAffectedServices(
      {
        base,
        head,
        baseSha: compare.baseSha,
        headSha: compare.headSha,
        status: compare.status,
        files: compare.files,
        truncated: compare.truncated,
      },
      graph,
    )
    if (graphError) {
      result.warnings.push(`Không lấy được dependency graph: ${graphError}`)
    }

    try {
      // Best-effort audit, same non-blocking contract as /api/builds — a
      // storage hiccup here must never fail an otherwise-successful preview.
      await appendAudit({
        idempotencyKey: `affected-services-preview:${compare.baseSha}:${compare.headSha}:${Date.now()}`,
        username: session.username,
        action: 'affected-services-preview',
        status: 'succeeded',
        details: { base, head, baseSha: compare.baseSha, headSha: compare.headSha, affectedServices: result.affectedServices, fellBackToAll: result.fellBackToAll },
      })
    } catch (auditError) {
      console.error('[builds/affected-services] appendAudit failed', { error: auditError instanceof Error ? auditError.message : 'Unknown error' })
    }

    const response: AffectedServicesResponse = { success: true, ...result }
    return NextResponse.json(response)
  } catch (error) {
    if (error instanceof CompareNotFoundError) {
      return buildError('commit_not_found', 404, error.message)
    }
    if (error instanceof CompareRateLimitedError) {
      return buildError('github_rate_limited', 429, error.message)
    }
    console.error('[builds/affected-services] failed', { base, head, error: error instanceof Error ? error.message : 'Unknown error' })
    return buildError('upstream_error', 502, error instanceof Error ? error.message : 'Unknown error')
  }
}
