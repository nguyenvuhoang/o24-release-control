import { redirect } from 'next/navigation'
import Dashboard from './components/Dashboard'
import { getSession } from '../lib/sessionCookies'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const session = await getSession()
  if (!session) redirect('/login')
  if (session.mustChangePassword) redirect('/change-password')
  return <Dashboard username={session.username} />
}
