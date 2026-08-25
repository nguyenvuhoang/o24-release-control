import type { DockerHubTagInfo } from './types'

const DOCKER_HUB_API_BASE = 'https://hub.docker.com/v2'

type DockerHubTagResponse = { digest?: string; last_updated?: string }

/**
 * Reads Docker Hub's public Hub API directly for a tag's current manifest
 * digest — no auth, no local `docker pull`. This is Registry Sync's whole
 * reason to exist: builds from Telegram or the DEV server push straight to
 * Docker Hub, so GitHub Actions is not the only source of a new image.
 * Returns null when the repository/tag doesn't exist (404) — a real,
 * meaningful answer, not an error.
 */
export async function fetchDockerHubTagDigest(repository: string, tag = 'latest'): Promise<DockerHubTagInfo | null> {
  const url = `${DOCKER_HUB_API_BASE}/repositories/${repository}/tags/${encodeURIComponent(tag)}`
  const response = await fetch(url, { cache: 'no-store' })
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`Docker Hub API ${response.status}: ${response.statusText}`)
  }
  const data = (await response.json()) as DockerHubTagResponse
  if (!data.digest) return null
  return { repoDigest: `${repository}@${data.digest}`, tag, lastUpdated: data.last_updated }
}

// The actual pull registry (distinct from hub.docker.com's Hub API above) —
// this is where an image's manifest/config, and therefore its OCI labels,
// actually live. Public repos still need a (anonymous) Bearer token per the
// Docker Registry v2 auth spec; there is no unauthenticated manifest read.
const DOCKER_REGISTRY_BASE = 'https://registry-1.docker.io/v2'
const DOCKER_AUTH_URL = 'https://auth.docker.io/token'
const OCI_REVISION_LABEL = 'org.opencontainers.image.revision'
const DIGEST_PATTERN = /sha256:[0-9a-f]{64}/i

const MANIFEST_ACCEPT = [
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.index.v1+json',
].join(', ')

type DockerManifestPlatform = { architecture: string; os: string }
type DockerManifestListEntry = { digest: string; platform?: DockerManifestPlatform }
type DockerManifest = {
  mediaType?: string
  config?: { digest: string }
  manifests?: DockerManifestListEntry[]
}
type DockerImageConfig = { config?: { Labels?: Record<string, string> } }

async function getAnonymousPullToken(repository: string): Promise<string | null> {
  const url = `${DOCKER_AUTH_URL}?service=registry.docker.io&scope=repository:${repository}:pull`
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) return null
  const data = (await response.json()) as { token?: string; access_token?: string }
  return data.token ?? data.access_token ?? null
}

async function fetchManifest(repository: string, reference: string, token: string): Promise<DockerManifest | null> {
  const response = await fetch(`${DOCKER_REGISTRY_BASE}/${repository}/manifests/${reference}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT },
    cache: 'no-store',
  })
  if (!response.ok) return null
  return (await response.json()) as DockerManifest
}

/**
 * Best-effort read of the org.opencontainers.image.revision label baked
 * into an image's config at build time (e.g. a Dockerfile LABEL or a
 * `docker buildx build --label`) — the ONLY signal Registry Sync uses to
 * learn a docker-registry release's git commit. Descends through a
 * multi-arch manifest list (preferring linux/amd64) to reach an actual
 * image config when needed. Returns null on ANY failure — missing auth,
 * network error, no such manifest, or simply no revision label present —
 * callers must treat that as "unknown", never fall back to guessing a
 * commit from branch/tag/timestamp.
 */
export async function fetchImageRevisionLabel(repository: string, repoDigest: string): Promise<string | null> {
  const digestMatch = repoDigest.match(DIGEST_PATTERN)
  if (!digestMatch) return null
  const digest = digestMatch[0]

  try {
    const token = await getAnonymousPullToken(repository)
    if (!token) return null

    let manifest = await fetchManifest(repository, digest, token)
    if (!manifest) return null

    if (manifest.manifests && manifest.manifests.length > 0) {
      const entry =
        manifest.manifests.find((item) => item.platform?.os === 'linux' && item.platform?.architecture === 'amd64') ?? manifest.manifests[0]
      manifest = await fetchManifest(repository, entry.digest, token)
      if (!manifest) return null
    }

    if (!manifest.config?.digest) return null

    const blobResponse = await fetch(`${DOCKER_REGISTRY_BASE}/${repository}/blobs/${manifest.config.digest}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    })
    if (!blobResponse.ok) return null
    const config = (await blobResponse.json()) as DockerImageConfig
    return config.config?.Labels?.[OCI_REVISION_LABEL]?.trim() || null
  } catch (error) {
    console.error('[dockerHub] failed to read image revision label', {
      repository,
      digest,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return null
  }
}
