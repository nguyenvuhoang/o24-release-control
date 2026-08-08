import { NextResponse } from 'next/server'
import { requireApiSession, errorResponse } from '../../../../lib/api'
import { getWorkflowRun } from '../../../../lib/github/client'

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const session = await requireApiSession()
  if (session instanceof NextResponse) return session

  const { runId } = await params
  const numericRunId = Number(runId)
  if (!Number.isInteger(numericRunId) || numericRunId <= 0) {
    return NextResponse.json({ error: 'invalid runId' }, { status: 400 })
  }

  try {
    const run = await getWorkflowRun(numericRunId)
    return NextResponse.json(run)
  } catch (error) {
    return errorResponse(error, 502)
  }
}
