import { redirect } from 'next/navigation'
import Dashboard from './components/Dashboard'
import { getSession } from '../lib/auth'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const session = await getSession()
  if (!session) redirect('/login')
  return <Dashboard username={session.username} />
}
