import { NextResponse } from 'next/server'
import { callAgent } from '../../../lib/agent'
import { requireApiSession, errorResponse } from '../../../lib/api'
import { loadControlConfig } from '../../../lib/config'
import { getConfiguredBuildBatchConcurrency, getConfiguredBuildBranch } from '../../../lib/github/client'
import { normalizeServiceStatus } from '../../../lib/serviceStatus'
import type { RawServiceStatus } from '../../../lib/serviceStatus'
import type { AgentStatus, DashboardResponse, EnvironmentDashboard, HostMetrics } from '../../../lib/types'

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
            callAgent<{ items: RawServiceStatus[] }>(environment, '/api/services'),
          ])
          if (process.env.NODE_ENV !== 'production') {
            // Deploy Agent 1.2.1 and earlier used a different ServiceStatus
            // field schema (image/imageID/digest/git_revision) — log the raw
            // wire response so a mismatch is diagnosable without guessing.
            console.debug('[dashboard] raw /api/services response', {
              environment: environment.code,
              items: services.items,
            })
          }
          // Host health is best-effort and never affects `online`: an agent
          // old enough to predate this endpoint, or a single slow/failed
          // sample, should still show its services normally — just without
          // the health row (the UI falls back to "Không lấy được thông tin
          // server" for that case).
          let hostMetrics: HostMetrics | undefined
          try {
            hostMetrics = await callAgent<HostMetrics>(environment, '/api/host/metrics', { timeoutMs: 8_000 })
          } catch (hostMetricsError) {
            if (process.env.NODE_ENV !== 'production') {
              console.debug('[dashboard] host metrics unavailable', {
                environment: environment.code,
                error: hostMetricsError instanceof Error ? hostMetricsError.message : hostMetricsError,
              })
            }
          }
          return {
            code: environment.code,
            name: environment.name,
            order: environment.order,
            online: true,
            agent,
            services: services.items.map(normalizeServiceStatus),
            hostMetrics,
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
      buildBranch: getConfiguredBuildBranch(),
      buildBatchConcurrency: getConfiguredBuildBatchConcurrency(),
    }
    return NextResponse.json(response)
  } catch (error) {
    return errorResponse(error)
  }
}
