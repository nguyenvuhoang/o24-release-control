import path from 'node:path'
import { kvCommand, resolveKvConfig } from '../kv'
import { GITHUB_API_BASE, GithubPermissionError, githubConfig } from './client'
import { BUILD_SERVICES, isBuildServiceCode, type BuildServiceCode } from './serviceMap'

// Live-derives the w4s monorepo's dependency graph for the 7 buildable
// services — deliberately NOT a hardcoded map in this repo's source. Every
// fact here is read straight from w4s at the ref being compared:
//   - .github/workflows/build-o24.yml tells us which service maps to which
//     Dockerfile (the same file build-o24.yml itself uses to build).
//   - Each service's Dockerfile tells us its root .csproj (via the
//     WORKDIR + "dotnet build" pair) and which non-project files
//     (Directory.Packages.props / Directory.Build.props) it explicitly
//     copies before `COPY . .` — i.e. actually feed the Docker image.
//   - O24OpenAPI.sln gives the full, authoritative list of known projects in
//     the solution, so a change in a module that exists but isn't referenced
//     by any of the 7 services (ACT, AI, BUZ, DWH, Design, EXT, PMT, Sample,
//     W4S) can be confidently classified as "no impact" instead of
//     "unknown".
//   - Each project's own ProjectReference graph (recursively) tells us the
//     real shared-dependency closure — this is what makes APIContracts/
//     GrpcContracts affect all 7 services, and OData affect only WFO,
//     without guessing at either.
// If w4s's structure changes (new service, renamed project, refactored
// Dockerfile), this keeps working without a code change here — only a
// parsing assumption breaking would require one, and that surfaces as a
// thrown error (see fetchDependencyGraph), which the resolver treats as
// "graph unavailable" and falls back to building everything, never to
// silently reporting no impact.

export type ServiceDependencyInfo = {
  service: BuildServiceCode
  dockerfile: string
  image: string
  rootCsproj: string
  /**
   * The service's own module folder — derived from rootCsproj, not a naming
   * guess: `O24OpenAPI/O24OpenAPI.CMS/O24OpenAPI.CMS.API/X.csproj` implies a
   * sibling-project module folder at `O24OpenAPI/O24OpenAPI.CMS` (containing
   * .API/.Domain/.Infrastructure). A closure dir under this is "this
   * service's own source"; every other closure dir is a shared dependency.
   */
  ownDir: string
  /** Every .csproj in this service's transitive ProjectReference closure, including its own. */
  projects: string[]
  /** Directory prefixes derived from `projects` — a changed file matches this service if its path starts with any of these. */
  dirs: string[]
  /** Directory.Packages.props / Directory.Build.props paths this service's own Dockerfile actually COPYs before `COPY . .`. */
  sharedPropsFiles: string[]
}

export type DependencyGraph = {
  ref: string
  services: Partial<Record<BuildServiceCode, ServiceDependencyInfo>>
  /** BUILD_SERVICES entries the workflow file didn't define — should be empty; surfaced so callers can warn instead of silently ignoring. */
  missingServices: BuildServiceCode[]
  /** Project directories known to exist in the solution (via O24OpenAPI.sln) but not referenced by any of the 7 services' closures. */
  knownUnrelatedDirs: string[]
  /**
   * The top-level folder shared by every project in O24OpenAPI.sln
   * (currently "O24OpenAPI") — derived, not hardcoded. A changed file
   * outside this folder (repo tooling, docs, .github config other than the
   * build workflow itself) is confidently "no Docker image impact": every
   * service Dockerfile's `COPY . .` picks it up byte-for-bit, but
   * `dotnet build`/`publish` only ever compiles the ProjectReference
   * closure resolved above, so a file nothing in that closure references
   * cannot change any image's contents.
   */
  solutionRoot: string
}

// ---- Pure parsing helpers (unit-tested directly, no network) ----

export function stripXmlComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, '')
}

/**
 * Resolves a .csproj's <ProjectReference Include="..."> entries to
 * repo-relative posix paths. Strips XML comments first — real w4s data has
 * at least one commented-out ProjectReference (WFO.Domain / IPS.Domain once
 * referenced an external "../Project/o24platform" path in a comment, since
 * replaced by a NuGet PackageReference); matching commented-out XML would
 * wrongly report a dependency that was never actually compiled.
 */
export function extractProjectReferences(csprojContent: string, csprojDir: string): string[] {
  const clean = stripXmlComments(csprojContent)
  const refs = [...clean.matchAll(/<ProjectReference\s+Include="([^"]+)"/g)].map((m) => m[1])
  return refs.map((ref) => path.posix.normalize(`${csprojDir}/${ref.replaceAll('\\', '/')}`))
}

/**
 * Parses the `case "${{ inputs.service }}" in ... esac` block in
 * build-o24.yml, extracting each service's `dockerfile=` and `image=`
 * outputs. This is the single source of truth build-o24.yml itself uses —
 * reading it live means a new/renamed service in the workflow is picked up
 * automatically, no control-center change required.
 */
export function parseServiceDockerfileMap(ymlContent: string): Partial<Record<BuildServiceCode, { dockerfile: string; image: string }>> {
  const result: Partial<Record<BuildServiceCode, { dockerfile: string; image: string }>> = {}
  const caseBlockPattern = /\n[ \t]*([A-Za-z0-9_]+)\)\s*\n([\s\S]*?);;/g
  let match: RegExpExecArray | null
  while ((match = caseBlockPattern.exec(ymlContent))) {
    const label = match[1].trim()
    if (!isBuildServiceCode(label)) continue
    const body = match[2]
    const dockerfileMatch = /dockerfile=([^\s"]+)/.exec(body)
    const imageMatch = /image=([^\s"]+)/.exec(body)
    if (!dockerfileMatch || !imageMatch) continue
    result[label] = { dockerfile: dockerfileMatch[1], image: imageMatch[1] }
  }
  return result
}

/**
 * Finds this service's root .csproj from its own Dockerfile: the
 * `WORKDIR "/src/<dir>"` immediately followed by `RUN dotnet build
 * "./<Name>.csproj"` pair, present in every service Dockerfile regardless of
 * whether it also has a separate `dotnet restore` step (WFO's doesn't).
 */
export function parseDockerfileRootCsproj(dockerfileContent: string): string | null {
  const workdirMatch = /WORKDIR\s+"\/src\/([^"]+)"/.exec(dockerfileContent)
  const buildMatch = /dotnet build\s+"\.\/([^"]+\.csproj)"/.exec(dockerfileContent)
  if (!workdirMatch || !buildMatch) return null
  return path.posix.normalize(`${workdirMatch[1]}/${buildMatch[1]}`)
}

/**
 * Every path this service's Dockerfile explicitly COPYs before the
 * catch-all `COPY . .` — i.e. what actually feeds the Docker build context
 * ahead of a full-repo copy. Used only to find which
 * Directory.Packages.props / Directory.Build.props this service depends on;
 * COPY lines pointing at this service's own .csproj files are filtered out
 * since those are already covered by the ProjectReference closure.
 */
export function parseDockerfileSharedPropsFiles(dockerfileContent: string): string[] {
  const beforeFullCopy = dockerfileContent.split(/\nCOPY \. \.\s/)[0]
  const copyMatches = [...beforeFullCopy.matchAll(/COPY\s+\["([^"]+)",/g)].map((m) => m[1])
  return copyMatches.filter((p) => p.endsWith('Directory.Packages.props') || p.endsWith('Directory.Build.props'))
}

/** Extracts every .csproj path declared in an O24OpenAPI.sln-style solution file. */
export function parseSlnProjects(slnContent: string): string[] {
  const matches = [...slnContent.matchAll(/Project\("\{[0-9A-Fa-f-]+\}"\)\s*=\s*"[^"]+",\s*"([^"]+\.csproj)"/g)]
  return matches.map((m) => m[1].replaceAll('\\', '/'))
}

/** The top-level folder shared by every project path — see DependencyGraph.solutionRoot. */
export function commonTopLevelDir(projectPaths: string[]): string {
  const firstSegments = new Set(projectPaths.map((p) => p.split('/')[0]))
  if (firstSegments.size !== 1) {
    throw new Error(`Solution projects do not share a single common top-level folder: ${[...firstSegments].join(', ')}`)
  }
  return [...firstSegments][0]
}

export function dirOf(csprojPath: string): string {
  return csprojPath.split('/').slice(0, -1).join('/')
}

// ---- Live fetch + orchestration ----

async function fetchRawFile(filePath: string, ref: string): Promise<string> {
  const { token, owner, repo, apiVersion } = githubConfig()
  const response = await fetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.raw+json',
        'X-GitHub-Api-Version': apiVersion,
      },
      cache: 'no-store',
    },
  )
  if (response.status === 403) {
    throw new GithubPermissionError(
      `/contents/${filePath}`,
      `GitHub token thiếu quyền Contents: Read-only cho ${filePath}@${ref}`,
    )
  }
  if (!response.ok) {
    throw new Error(`GitHub content fetch failed for ${filePath}@${ref}: ${response.status} ${response.statusText}`)
  }
  return response.text()
}

/**
 * Recursively resolves a .csproj's full ProjectReference closure, fetching
 * each newly-discovered project exactly once via `cache` (shared across
 * every service in one fetchDependencyGraph call, since APIContracts/
 * GrpcContracts are referenced by nearly all of them).
 */
async function resolveClosure(rootCsproj: string, ref: string, cache: Map<string, string>): Promise<string[]> {
  const seen = new Set<string>()
  const stack = [rootCsproj]
  while (stack.length > 0) {
    const current = stack.pop() as string
    if (seen.has(current)) continue
    seen.add(current)

    let content = cache.get(current)
    if (content === undefined) {
      content = await fetchRawFile(current, ref)
      cache.set(current, content)
    }
    const refs = extractProjectReferences(content, dirOf(current))
    for (const dep of refs) {
      if (!seen.has(dep)) stack.push(dep)
    }
  }
  return [...seen]
}

/**
 * Fetches every file needed and builds the full dependency graph for `sha` —
 * no caching concerns here, this is the expensive ~40-request path that the
 * cache layers below exist to avoid repeating. Throws if any required file
 * can't be fetched or parsed as expected — callers (the affected-services
 * resolver) must treat that as "graph unavailable" and fall back to building
 * every service, never as "nothing is affected".
 */
async function buildGraphFromGitHub(sha: string): Promise<DependencyGraph> {
  const [ymlContent, slnContent] = await Promise.all([
    fetchRawFile('.github/workflows/build-o24.yml', sha),
    fetchRawFile('O24OpenAPI.sln', sha),
  ])

  const serviceDockerMap = parseServiceDockerfileMap(ymlContent)
  const missingServices = BUILD_SERVICES.filter((service) => !serviceDockerMap[service])

  const csprojCache = new Map<string, string>()
  const services: Partial<Record<BuildServiceCode, ServiceDependencyInfo>> = {}

  for (const service of BUILD_SERVICES) {
    const info = serviceDockerMap[service]
    if (!info) continue

    const dockerfileContent = await fetchRawFile(info.dockerfile, sha)

    const rootCsproj = parseDockerfileRootCsproj(dockerfileContent)
    if (!rootCsproj) {
      throw new Error(`Could not determine root .csproj for service ${service} from ${info.dockerfile}`)
    }

    const projects = await resolveClosure(rootCsproj, sha, csprojCache)
    const dirs = [...new Set(projects.map(dirOf))]
    const sharedPropsFiles = parseDockerfileSharedPropsFiles(dockerfileContent)
    const ownDir = dirOf(dirOf(rootCsproj))

    services[service] = {
      service,
      dockerfile: info.dockerfile,
      image: info.image,
      rootCsproj,
      ownDir,
      projects,
      dirs,
      sharedPropsFiles,
    }
  }

  const allSlnProjects = parseSlnProjects(slnContent)
  const referencedDirs = new Set(Object.values(services).flatMap((s) => (s ? s.dirs : [])))
  const knownUnrelatedDirs = [...new Set(allSlnProjects.map(dirOf).filter((dir) => !referencedDirs.has(dir)))]
  const solutionRoot = commonTopLevelDir(allSlnProjects)

  return { ref: sha, services, missingServices, knownUnrelatedDirs, solutionRoot }
}

// ---- Caching: memory (fast, per-instance) -> Redis (persistent, shared
// across instances/cold starts) -> live GitHub fetch. Keyed by the resolved
// commit SHA (never a branch name — branches move, SHAs don't), so a hit is
// valid forever in principle; TTLs below exist only to bound growth, not
// because the data can go stale. ----

export type GraphSource = 'memory' | 'redis' | 'github'

const MEMORY_TTL_MS = 60 * 60 * 1000 // 1h safety net for a long-lived instance; irrelevant on Vercel's short-lived ones
const REDIS_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 days — long-lived since the SHA is immutable, bounded so old previews eventually fall out
const LOCK_TTL_MS = 30_000
const LOCK_WAIT_TIMEOUT_MS = 15_000
const LOCK_POLL_INTERVAL_MS = 500

const memoryCache = new Map<string, { at: number; graph: DependencyGraph }>()
// In-process singleflight: a second concurrent request for the same SHA on
// the same warm instance piggybacks on the first's in-flight fetch instead
// of starting a duplicate one.
const inflight = new Map<string, Promise<DependencyGraph>>()

function redisGraphKey(owner: string, repo: string, sha: string): string {
  return `o24:depgraph:${owner}/${repo}:${sha}`
}

function redisLockKey(owner: string, repo: string, sha: string): string {
  return `o24:depgraph:lock:${owner}/${repo}:${sha}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Best-effort cross-instance dedup — NOT a strict distributed lock. If this
 * instance can't acquire the Redis lock (another instance is already
 * building the same SHA), it polls the cache key briefly for that other
 * instance's result; if the wait times out, it builds anyway rather than
 * risk starving the request. This trades a small chance of two instances
 * both fetching the same SHA once for never deadlocking or hanging a
 * request indefinitely.
 */
async function buildWithCrossInstanceDedup(
  kvConfig: NonNullable<ReturnType<typeof resolveKvConfig>>,
  owner: string,
  repo: string,
  sha: string,
): Promise<DependencyGraph> {
  const lockKey = redisLockKey(owner, repo, sha)
  const gotLock = await kvCommand(kvConfig, ['SET', lockKey, '1', 'NX', 'PX', LOCK_TTL_MS]).catch(() => null)

  if (gotLock !== 'OK') {
    const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS
    while (Date.now() < deadline) {
      await sleep(LOCK_POLL_INTERVAL_MS)
      const raw = await kvCommand(kvConfig, ['GET', redisGraphKey(owner, repo, sha)]).catch(() => null)
      if (typeof raw === 'string') {
        console.log('[w4sGraph] cache hit (redis, after waiting on cross-instance lock)', { sha })
        return JSON.parse(raw) as DependencyGraph
      }
    }
    console.log('[w4sGraph] cross-instance lock wait timed out — building locally', { sha })
  }

  const graph = await buildGraphFromGitHub(sha)
  await kvCommand(kvConfig, ['SET', redisGraphKey(owner, repo, sha), JSON.stringify(graph), 'EX', REDIS_TTL_SECONDS]).catch((error) => {
    console.error('[w4sGraph] failed to persist graph to redis', { sha, error: error instanceof Error ? error.message : 'Unknown error' })
  })
  return graph
}

/**
 * Resolves the dependency graph for `sha` (must already be a resolved commit
 * SHA, not a branch name — see the affected-services route, which resolves
 * `head` via compareCommits before calling this). Checks memory, then Redis,
 * then falls back to a live GitHub fetch (deduped in-process, best-effort
 * deduped cross-instance via Redis lock). Never logs the token.
 */
export async function fetchDependencyGraph(sha: string): Promise<{ graph: DependencyGraph; source: GraphSource }> {
  const cachedMemory = memoryCache.get(sha)
  if (cachedMemory && Date.now() - cachedMemory.at < MEMORY_TTL_MS) {
    console.log('[w4sGraph] cache hit (memory)', { sha })
    return { graph: cachedMemory.graph, source: 'memory' }
  }

  const { owner, repo } = githubConfig()
  const kvConfig = resolveKvConfig()
  if (kvConfig) {
    const raw = await kvCommand(kvConfig, ['GET', redisGraphKey(owner, repo, sha)]).catch(() => null)
    if (typeof raw === 'string') {
      const graph = JSON.parse(raw) as DependencyGraph
      memoryCache.set(sha, { at: Date.now(), graph })
      console.log('[w4sGraph] cache hit (redis)', { sha })
      return { graph, source: 'redis' }
    }
  }

  const existingInflight = inflight.get(sha)
  if (existingInflight) {
    console.log('[w4sGraph] piggybacking on in-flight fetch for this instance', { sha })
    return { graph: await existingInflight, source: 'github' }
  }

  const promise = kvConfig ? buildWithCrossInstanceDedup(kvConfig, owner, repo, sha) : buildGraphFromGitHub(sha)
  inflight.set(sha, promise)
  try {
    console.log('[w4sGraph] cache miss -> fetching from GitHub', { sha })
    const graph = await promise
    memoryCache.set(sha, { at: Date.now(), graph })
    if (!kvConfig) {
      console.log('[w4sGraph] Redis not configured — graph will not persist across cold starts/instances', { sha })
    }
    return { graph, source: 'github' }
  } finally {
    inflight.delete(sha)
  }
}

/** Test-only: forces the next fetchDependencyGraph(sha) call to re-fetch instead of using any cache. */
export function resetDependencyGraphCacheForTests(): void {
  memoryCache.clear()
  inflight.clear()
}
