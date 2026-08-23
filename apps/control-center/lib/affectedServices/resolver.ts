import { BUILD_SERVICES, type BuildServiceCode } from '../github/serviceMap'
import type { DependencyGraph } from '../github/w4sGraph'
import type {
  AffectedServiceChangedFile,
  AffectedServiceMatchedRule,
  AffectedServicesCompareMeta,
  AffectedServicesResult,
} from '../types'

export type ResolverCompareInput = {
  base: string
  head: string
  baseSha: string
  headSha: string
  status: AffectedServicesCompareMeta['status']
  files: AffectedServiceChangedFile[]
  truncated: boolean
}

function isUnderDir(filePath: string, dir: string): boolean {
  return filePath === dir || filePath.startsWith(`${dir}/`)
}

function classifyOneFile(
  filePath: string,
  graph: DependencyGraph,
): { rule: AffectedServiceMatchedRule['rule']; services: BuildServiceCode[]; reason: string } {
  if (filePath === '.github/workflows/build-o24.yml') {
    return {
      rule: 'workflow-change',
      services: [],
      reason: 'Thay đổi trong build-o24.yml — không xác định được phạm vi ảnh hưởng bằng path matcher tĩnh',
    }
  }

  // Outside the solution folder entirely (docs, repo tooling, .github config
  // other than the build workflow) — every Dockerfile's `COPY . .` still
  // picks these up byte-for-byte, but `dotnet build`/`publish` never
  // compiles anything nothing in the ProjectReference closure references,
  // so this can never change any image's contents.
  if (!isUnderDir(filePath, graph.solutionRoot)) {
    return { rule: 'known-unrelated', services: [], reason: `${filePath} nằm ngoài thư mục solution (${graph.solutionRoot}/) — không ảnh hưởng nội dung Docker image` }
  }

  // Directory.Packages.props / Directory.Build.props — only "shared" for a
  // service if that service's OWN Dockerfile actually COPYs it (verified
  // live per service, see w4sGraph.parseDockerfileSharedPropsFiles).
  if (filePath.endsWith('Directory.Packages.props') || filePath.endsWith('Directory.Build.props')) {
    const affected = BUILD_SERVICES.filter((service) => graph.services[service]?.sharedPropsFiles.includes(filePath))
    if (affected.length > 0) {
      return {
        rule: 'shared-props',
        services: affected,
        reason: `${filePath} được copy vào Docker build context của ${affected.join(', ')} — ảnh hưởng toàn bộ service này`,
      }
    }
    // A Directory.Packages.props/Directory.Build.props that exists but isn't
    // copied by any service's Dockerfile (e.g. the repo-root one) — known,
    // confirmed no impact, not "unknown".
    return { rule: 'known-unrelated', services: [], reason: `${filePath} không được Dockerfile của service nào copy vào build context` }
  }

  // Direct or shared-dependency: does this file live under a service's
  // resolved ProjectReference closure directory?
  const owningServices: BuildServiceCode[] = []
  let isOwnSourceOf: BuildServiceCode | null = null
  for (const service of BUILD_SERVICES) {
    const info = graph.services[service]
    if (!info) continue
    if (info.dirs.some((dir) => isUnderDir(filePath, dir))) {
      owningServices.push(service)
      if (isUnderDir(filePath, info.ownDir)) isOwnSourceOf = service
    }
  }

  if (owningServices.length === 1 && isOwnSourceOf === owningServices[0]) {
    return { rule: 'direct', services: owningServices, reason: `Thay đổi trực tiếp trong source ${owningServices[0]}` }
  }
  if (owningServices.length > 0) {
    return {
      rule: 'shared-dependency',
      services: owningServices,
      reason: `${filePath} thuộc dependency dùng chung, được ${owningServices.join(', ')} tham chiếu`,
    }
  }

  // Known w4s module (verified via O24OpenAPI.sln) that no tracked service references.
  if (graph.knownUnrelatedDirs.some((dir) => isUnderDir(filePath, dir))) {
    return { rule: 'known-unrelated', services: [], reason: `${filePath} thuộc module w4s không được service nào trong 7 service tham chiếu` }
  }

  return { rule: 'unknown', services: [], reason: `Không xác định được phạm vi ảnh hưởng của ${filePath}` }
}

/**
 * Pure classification — takes an already-fetched compare result and an
 * already-built dependency graph, never touches the network itself (so it's
 * directly unit-testable against fixtures). Any file this can't confidently
 * classify — or a graph that failed to build at all — makes the WHOLE
 * result fall back to "build every service", per the safety requirement:
 * never silently under-build because a path went unrecognized.
 */
export function resolveAffectedServices(compare: ResolverCompareInput, graph: DependencyGraph | null): AffectedServicesResult {
  const warnings: string[] = []
  const matchedRules: AffectedServiceMatchedRule[] = []
  const reasons: Partial<Record<BuildServiceCode, string[]>> = {}
  let fellBackToAll = false

  function addReason(service: BuildServiceCode, reason: string) {
    ;(reasons[service] ??= []).push(reason)
  }

  if (compare.truncated) {
    warnings.push('Danh sách file thay đổi vượt quá giới hạn của GitHub Compare API (300 file) — không thể đảm bảo đã thấy hết mọi thay đổi.')
    fellBackToAll = true
  }

  if (!graph) {
    warnings.push('Không lấy được dependency graph trực tiếp từ w4s (xem log server) — mặc định build tất cả để an toàn.')
    fellBackToAll = true
  } else {
    if (graph.missingServices.length > 0) {
      warnings.push(`build-o24.yml không định nghĩa service: ${graph.missingServices.join(', ')} — các service này sẽ luôn được build khi rơi vào fallback.`)
    }
    for (const file of compare.files) {
      const pathsToCheck = file.previousFilename ? [file.filename, file.previousFilename] : [file.filename]
      for (const filePath of pathsToCheck) {
        const classification = classifyOneFile(filePath, graph)
        matchedRules.push({ file: filePath, rule: classification.rule, services: classification.services, reason: classification.reason })
        if (classification.rule === 'unknown' || classification.rule === 'workflow-change') {
          warnings.push(classification.reason)
          fellBackToAll = true
        }
        for (const service of classification.services) {
          addReason(service, classification.reason)
        }
      }
    }
  }

  const affectedServices = fellBackToAll
    ? [...BUILD_SERVICES]
    : [...new Set(matchedRules.flatMap((rule) => rule.services))].sort((a, b) => BUILD_SERVICES.indexOf(a) - BUILD_SERVICES.indexOf(b))

  if (fellBackToAll) {
    for (const service of BUILD_SERVICES) {
      if (!reasons[service]?.length) addReason(service, 'Fallback an toàn: build tất cả service do có thay đổi không xác định được phạm vi ảnh hưởng')
    }
  }

  const unaffectedServices = BUILD_SERVICES.filter((service) => !affectedServices.includes(service))

  return {
    affectedServices,
    unaffectedServices,
    changedFiles: compare.files,
    matchedRules,
    reasons,
    warnings,
    fellBackToAll,
    compareMeta: {
      base: compare.base,
      head: compare.head,
      baseSha: compare.baseSha,
      headSha: compare.headSha,
      status: compare.status,
      totalFiles: compare.files.length,
      truncated: compare.truncated,
    },
  }
}
