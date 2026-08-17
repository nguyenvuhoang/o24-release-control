import { NextResponse } from 'next/server'
import { appendBuildAudit } from '../../../../lib/audit'
import { requireApiSession, errorResponse } from '../../../../lib/api'
import { getWorkflowRun } from '../../../../lib/github/client'

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const session = await requireApiSession()
  if (session instanceof NextResponse) return session

  const { runId } = await params
  const numericRunId = Number(runId)
  if (!Number.isInteger(numericRunId) || numericRunId <= 0) {
    return NextResponse.json({ error: 'invalid runId' }, { status: 400 })
  }
  // The client (useBuildTracker) is the source of truth for which service
  // triggered this run — GitHub's run API doesn't echo back the
  // workflow_dispatch `service` input, only the branch/commit.
  const service = new URL(request.url).searchParams.get('service') ?? undefined

  try {
    const run = await getWorkflowRun(numericRunId)
    await appendBuildAudit(run, service, session.username)
    return NextResponse.json(run)
  } catch (error) {
    return errorResponse(error, 502)
  }
}
