import { NextResponse } from 'next/server'
import { validateCredentials } from '../../../../lib/auth'
import { createSession } from '../../../../lib/sessionCookies'

export async function POST(request: Request) {
  const form = await request.formData()

  const username = String(form.get('username') ?? '').trim()
  const password = String(form.get('password') ?? '')

  const identity = await validateCredentials(username, password)
  if (!identity) {
    return new NextResponse(null, {
      status: 303,
      headers: {
        Location: '/login?error=1',
      },
    })
  }

  await createSession(identity)

  return new NextResponse(null, {
    status: 303,
    headers: {
      Location: '/',
    },
  })
}