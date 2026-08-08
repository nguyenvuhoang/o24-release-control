import { NextResponse } from 'next/server'
import { streamAgent } from '../../../../../lib/agent'
import { requireApiSession } from '../../../../../lib/api'
import { getEnvironment } from '../../../../../lib/config'

// Never statically optimize/cache an SSE stream.
export const dynamic = 'force-dynamic'

// Proxies the agent's realtime operation log stream to the browser. The
// browser only ever talks to this Next.js route (never the agent directly);
// the HMAC-signed request to the agent happens server-side here.
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
    const agentResponse = await streamAgent(environment, `/api/operations/${encodeURIComponent(operationId)}/stream`)
    return new NextResponse(agentResponse.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'request_failed', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 502 },
    )
  }
}
