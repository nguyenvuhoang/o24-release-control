import { NextResponse } from 'next/server'
import { callAgent } from '../../../lib/agent'
import { requireApiSession, errorResponse } from '../../../lib/api'
import { loadControlConfig } from '../../../lib/config'
import type { AgentStatus, DashboardResponse, EnvironmentDashboard, ServiceStatus } from '../../../lib/types'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await requireApiSession()
  if (session instanceof NextResponse) return session
  try {
    const config = await loadControlConfig()
    const environments: EnvironmentDashboard[] = await Promise.all(
      config.environments.map(async (environment) => {
        try {
          const [agent, services] = await Promise.all([
            callAgent<AgentStatus>(environment, '/api/status'),
            callAgent<{ items: ServiceStatus[] }>(environment, '/api/services'),
          ])
          return {
            code: environment.code,
            name: environment.name,
            order: environment.order,
            online: true,
            agent,
            services: services.items,
          }
        } catch (error) {
          return {
            code: environment.code,
            name: environment.name,
            order: environment.order,
            online: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            services: [],
          }
        }
      }),
    )
    const response: DashboardResponse = {
      applicationName: config.applicationName ?? 'O24 Release Control',
      generatedAt: new Date().toISOString(),
      environments,
    }
    return NextResponse.json(response)
  } catch (error) {
    return errorResponse(error)
  }
}
