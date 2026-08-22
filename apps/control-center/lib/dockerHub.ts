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
