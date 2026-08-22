import { NextResponse } from 'next/server'
import { requireApiSession, errorResponse } from '../../../../lib/api'
import { fetchDockerHubTagDigest } from '../../../../lib/dockerHub'
import { BUILD_SERVICES, imageRepositoryFor } from '../../../../lib/github/serviceMap'
import { getReleaseRepository } from '../../../../lib/releaseRepository'
import type { RegistryServiceStatus, RegistryStatusResponse } from '../../../../lib/types'

export const dynamic = 'force-dynamic'

// Deliberately does NOT call any Deploy Agent: DEV/UAT/PROD's current
// repoDigest per service is already on the client from /api/dashboard, so
// the comparison there is derived client-side instead of doubling agent
// traffic just to re-fetch numbers the page already has.
export async function GET() {
  const session = await requireApiSession()
  if (session instanceof NextResponse) return session

  try {
    const releaseRepository = getReleaseRepository()

    const services: RegistryServiceStatus[] = await Promise.all(
      BUILD_SERVICES.map(async (service) => {
        const dockerRepository = imageRepositoryFor(service)
        const [dockerHub, latest] = await Promise.all([
          fetchDockerHubTagDigest(dockerRepository).catch((error) => {
            console.error('[registry] Docker Hub lookup failed', {
              service,
              dockerRepository,
              error: error instanceof Error ? error.message : 'Unknown error',
            })
            return null
          }),
          releaseRepository.list({ service, limit: 1 }),
        ])
        return {
          service,
          dockerRepository,
          dockerHub: dockerHub ?? undefined,
          latestRelease: latest.items[0],
        }
      }),
    )

    const response: RegistryStatusResponse = { generatedAt: new Date().toISOString(), services }
    return NextResponse.json(response)
  } catch (error) {
    return errorResponse(error)
  }
}
