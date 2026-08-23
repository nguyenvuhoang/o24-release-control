import { NextResponse } from 'next/server'
import { requireApiSession } from '../../../../lib/api'

// Deliberately exempt from the mustChangePassword gate — the client needs
// this to even KNOW it must redirect to /change-password in the first
// place (see app/page.tsx / app/login/page.tsx, which read the session
// server-side directly; this endpoint is for the client-side form/redirect
// logic that can't call getSession() itself).
export async function GET() {
  const session = await requireApiSession({ allowPasswordChangeRequired: true })
  if (session instanceof NextResponse) return session
  return NextResponse.json({ username: session.username, role: session.role, mustChangePassword: session.mustChangePassword })
}
