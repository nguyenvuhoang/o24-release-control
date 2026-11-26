import { NextResponse } from 'next/server'
import { AuthStorageError, validateCredentials } from '../../../../lib/auth'
import { createSession } from '../../../../lib/sessionCookies'

export async function POST(request: Request) {
  const form = await request.formData()

  const username = String(form.get('username') ?? '').trim()
  const password = String(form.get('password') ?? '')

  let identity
  try {
    identity = await validateCredentials(username, password)
  } catch (error) {
    if (error instanceof AuthStorageError) {
      // A transient KV failure, NOT a bad password — must never redirect as
      // "/login?error=1" (that reads as "wrong credentials" and sends a
      // correctly-typing user into pointless retries). Surfaced honestly so
      // the login page can show "thử lại sau" instead.
      console.error('[auth/login] user store unavailable', { username, error: error.message })
      return new NextResponse(null, { status: 303, headers: { Location: '/login?error=storage' } })
    }
    throw error
  }
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