import { NextResponse } from 'next/server'
import { requireApiSession, errorResponse } from '../../../lib/api'
import { readAudit } from '../../../lib/audit'

export async function GET(request: Request) {
  const session = await requireApiSession()
  if (session instanceof NextResponse) return session
  try {
    const url = new URL(request.url)
    const limit = Number(url.searchParams.get('limit') ?? 30)
    return NextResponse.json({ items: await readAudit(limit) })
  } catch (error) {
    return errorResponse(error)
  }
}
