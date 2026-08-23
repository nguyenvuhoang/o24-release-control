import path from 'node:path'
import { GITHUB_API_BASE, githubConfig } from './client'
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

const GRAPH_CACHE_TTL_MS = 10 * 60 * 1000
const graphCache = new Map<string, { at: number; graph: DependencyGraph }>()

/**
 * Builds the full live dependency graph for `ref` (a branch name or SHA).
 * Throws if any required file can't be fetched or parsed as expected —
 * callers (the affected-services resolver) must treat that as "graph
 * unavailable" and fall back to building every service, never as "nothing
 * is affected".
 */
export async function fetchDependencyGraph(ref: string): Promise<DependencyGraph> {
  const cached = graphCache.get(ref)
  if (cached && Date.now() - cached.at < GRAPH_CACHE_TTL_MS) {
    return cached.graph
  }

  const [ymlContent, slnContent] = await Promise.all([
    fetchRawFile('.github/workflows/build-o24.yml', ref),
    fetchRawFile('O24OpenAPI.sln', ref),
  ])

  const serviceDockerMap = parseServiceDockerfileMap(ymlContent)
  const missingServices = BUILD_SERVICES.filter((service) => !serviceDockerMap[service])

  const dockerfileCache = new Map<string, string>()
  const csprojCache = new Map<string, string>()
  const services: Partial<Record<BuildServiceCode, ServiceDependencyInfo>> = {}

  for (const service of BUILD_SERVICES) {
    const info = serviceDockerMap[service]
    if (!info) continue

    const dockerfileContent = await fetchRawFile(info.dockerfile, ref)
    dockerfileCache.set(info.dockerfile, dockerfileContent)

    const rootCsproj = parseDockerfileRootCsproj(dockerfileContent)
    if (!rootCsproj) {
      throw new Error(`Could not determine root .csproj for service ${service} from ${info.dockerfile}`)
    }

    const projects = await resolveClosure(rootCsproj, ref, csprojCache)
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

  const graph: DependencyGraph = { ref, services, missingServices, knownUnrelatedDirs, solutionRoot }
  graphCache.set(ref, { at: Date.now(), graph })
  return graph
}

/** Test-only: forces the next fetchDependencyGraph(ref) call to re-fetch instead of using the cache. */
export function resetDependencyGraphCacheForTests(): void {
  graphCache.clear()
}
