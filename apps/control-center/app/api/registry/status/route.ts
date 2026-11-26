import { NextResponse } from 'next/server'
import { requireApiSession, errorResponse } from '../../../../lib/api'
import { getLatestBuildIntents } from '../../../../lib/buildPointerStore'
import { mapWithConcurrency } from '../../../../lib/concurrency'
import { fetchDockerHubTagDigest } from '../../../../lib/dockerHub'
import { BUILD_SERVICES, imageRepositoryFor, type BuildServiceCode } from '../../../../lib/github/serviceMap'
import { resolveLatestRelease } from '../../../../lib/latestReleaseResolver'
import { getReleaseRepository } from '../../../../lib/releaseRepository'
import type { DockerHubTagInfo, RegistryServiceStatus, RegistryStatusResponse } from '../../../../lib/types'

export const dynamic = 'force-dynamic'

// Max simultaneous Docker Hub lookups / release-repository reads this route
// fires at once (both the Docker Hub pass and the list()/resolve pass below
// are run through this, never a flat Promise.all over all 7 services) — see
// docs/REDIS_GATEWAY.md's root-cause note: an uncapped 7-way fan-out here,
// doubled by the equally uncapped 7-way client fan-out to
// /api/releases/environment-state, is what drove the Redis Gateway's
// "request timed out after 15000ms" failures. Same sizing rationale as
// getConfiguredBuildBatchConcurrency (never unbounded-parallel), overridable
// via env for deployments that want a different cap.
function getConfiguredRegistryStatusConcurrency(): number {
  const raw = Number(process.env.REGISTRY_STATUS_CONCURRENCY)
  return Number.isInteger(raw) && raw > 0 ? raw : 3
}

function digestLookupKey(service: BuildServiceCode, repoDigest: string): string {
  return `${service}:${repoDigest}`
}

// Deliberately does NOT call any Deploy Agent: DEV/UAT/PROD's current
// repoDigest per service is already on the client from /api/dashboard, so
// the comparison there is derived client-side instead of doubling agent
// traffic just to re-fetch numbers the page already has.
export async function GET() {
  const session = await requireApiSession()
  if (session instanceof NextResponse) return session

  try {
    const releaseRepository = getReleaseRepository()
    const concurrency = getConfiguredRegistryStatusConcurrency()

    // Pass 1: Docker Hub digests for every service, bounded so this route
    // never opens BUILD_SERVICES.length sockets to Docker Hub at once either.
    const dockerHubByService = new Map<BuildServiceCode, DockerHubTagInfo | null>()
    await mapWithConcurrency(BUILD_SERVICES, concurrency, async (service) => {
      const dockerRepository = imageRepositoryFor(service)
      const dockerHub = await fetchDockerHubTagDigest(dockerRepository).catch((error) => {
        console.error('[registry] Docker Hub lookup failed', {
          service,
          dockerRepository,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
        return null
      })
      dockerHubByService.set(service, dockerHub)
    })

    // Pass 2: every service's "does a snapshot already match this digest"
    // and "who last requested a build for this service" check, each batched
    // into ONE Gateway/Upstash MGET total across all 7 services — replacing
    // what used to be 2 separate Redis requests PER service (getByDigest,
    // getLatestBuildIntent), fired concurrently, on every Dashboard load.
    const digestLookupPairs = BUILD_SERVICES.flatMap((service) => {
      const dockerHub = dockerHubByService.get(service)
      return dockerHub ? [{ service, repoDigest: dockerHub.repoDigest }] : []
    })
    const [matchedSnapshots, buildIntents] = await Promise.all([
      releaseRepository.getByDigests(digestLookupPairs).catch((error) => {
        console.error('[registry] batched release digest lookup failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        })
        return digestLookupPairs.map(() => undefined)
      }),
      getLatestBuildIntents(BUILD_SERVICES).catch((error) => {
        console.error('[registry] batched build intent lookup failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        })
        return new Map()
      }),
    ])
    const matchedSnapshotByKey = new Map(
      digestLookupPairs.map((pair, index) => [digestLookupKey(pair.service, pair.repoDigest), matchedSnapshots[index]]),
    )

    // Pass 3: per-service release history (list()) + the full resolver —
    // the resolver's own getByDigest/getLatestBuildIntent overrides read
    // straight from the maps built above (zero further Gateway requests);
    // only a GitHub Actions run scan (not Redis) may still happen here, when
    // no snapshot already matches the current Docker Hub digest — e.g. a
    // freshly-cut Redis database with no release history yet. Each service
    // is still resolved independently — one service's transient KV/GitHub
    // hiccup must never 500 the entire registry status response for every
    // other (otherwise-healthy) service; a failed lookup is reported, just
    // without the fields that couldn't be resolved.
    const services: RegistryServiceStatus[] = await mapWithConcurrency(BUILD_SERVICES, concurrency, async (service) => {
      const dockerRepository = imageRepositoryFor(service)
      const dockerHub = dockerHubByService.get(service) ?? null

      const [latest, latestBuild] = await Promise.all([
        releaseRepository.list({ service, limit: 1 }).catch((error) => {
          console.error('[registry] release repository lookup failed', {
            service,
            error: error instanceof Error ? error.message : 'Unknown error',
          })
          return { items: [] }
        }),
        resolveLatestRelease(service, {
          dockerHub,
          getByDigest: async (svc, repoDigest) => matchedSnapshotByKey.get(digestLookupKey(svc, repoDigest)),
          getLatestBuildIntent: async (svc) => buildIntents.get(svc),
        }).catch((error) => {
          console.error('[registry] resolveLatestRelease failed', {
            service,
            error: error instanceof Error ? error.message : 'Unknown error',
          })
          return null
        }),
      ])
      return {
        service,
        dockerRepository,
        dockerHub: dockerHub ?? undefined,
        latestRelease: latest.items[0],
        latestBuild: latestBuild ?? undefined,
      }
    })

    const response: RegistryStatusResponse = { generatedAt: new Date().toISOString(), services }
    return NextResponse.json(response)
  } catch (error) {
    return errorResponse(error)
  }
}
