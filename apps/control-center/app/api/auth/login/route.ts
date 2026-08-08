import { NextResponse } from 'next/server'
import { createSession, validateCredentials } from '../../../../lib/auth'

export async function POST(request: Request) {
  const form = await request.formData()

  const username = String(form.get('username') ?? '').trim()
  const password = String(form.get('password') ?? '')

  if (!validateCredentials(username, password)) {
    return new NextResponse(null, {
      status: 303,
      headers: {
        Location: '/login?error=1',
      },
    })
  }

  await createSession(username)

  return new NextResponse(null, {
    status: 303,
    headers: {
      Location: '/',
    },
  })
}