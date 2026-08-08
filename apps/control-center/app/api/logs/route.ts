import { NextResponse } from 'next/server'
import { callAgent } from '../../../lib/agent'
import { requireApiSession, errorResponse } from '../../../lib/api'
import { getEnvironment } from '../../../lib/config'

export async function GET(request: Request) {
  const session = await requireApiSession()
  if (session instanceof NextResponse) return session
  const url = new URL(request.url)
  const environmentCode = url.searchParams.get('environment')
  const service = url.searchParams.get('service')
  const tail = Math.min(Math.max(Number(url.searchParams.get('tail') ?? 300), 1), 2000)
  if (!environmentCode || !service) {
    return NextResponse.json({ error: 'environment and service are required' }, { status: 400 })
  }
  try {
    const environment = await getEnvironment(environmentCode)
    const result = await callAgent(environment, `/api/services/${encodeURIComponent(service)}/logs?tail=${tail}`)
    return NextResponse.json(result)
  } catch (error) {
    return errorResponse(error, 502)
  }
}
