import {
  ACTIVE_PROJECT_PROFILE,
  getProjectProfile,
  type ProjectCode,
  type ServiceCode,
} from '../projectProfile'

export type BuildServiceCode = ServiceCode

export const BUILD_SERVICES: readonly BuildServiceCode[] = ACTIVE_PROJECT_PROFILE.services

export function serviceCodesForProfile(project: ProjectCode): readonly BuildServiceCode[] {
  return getProjectProfile(project).services
}

export function isServiceCodeForProfile(project: ProjectCode, value: string): value is BuildServiceCode {
  return serviceCodesForProfile(project).includes(value as BuildServiceCode)
}

export function isBuildServiceCode(value: string): value is BuildServiceCode {
  return BUILD_SERVICES.includes(value as BuildServiceCode)
}

export function imageRepositoryFor(service: BuildServiceCode): string {
  return imageRepositoryForProfile(ACTIVE_PROJECT_PROFILE.code, service)
}

export function imageRepositoryForProfile(project: ProjectCode, service: BuildServiceCode): string {
  if (!isServiceCodeForProfile(project, service)) {
    throw new Error(`Service ${service} is not available for project ${project}`)
  }
  return `${getProjectProfile(project).imagePrefix}${service.toLowerCase()}`
}

// Deploy Agent service codes already follow the "o24-<name>" convention (see
// examples/server/agent-config.example.json — o24-wfo, o24-cms, ...), so the
// GitHub build service code is derived from it instead of maintaining a
// second, separately-hardcoded service catalog.
export function githubServiceForAgentCode(
  agentServiceCode: string,
): BuildServiceCode | null {
  return githubServiceForAgentCodeForProfile(ACTIVE_PROJECT_PROFILE.code, agentServiceCode)
}

export function githubServiceForAgentCodeForProfile(
  project: ProjectCode,
  agentServiceCode: string,
): BuildServiceCode | null {
  const match = /^o24-([a-z0-9]+)$/i.exec(agentServiceCode);
  if (!match) return null;
  const candidate = match[1].toUpperCase();
  return isServiceCodeForProfile(project, candidate) ? candidate : null
}

/**
 * Resolves a BuildServiceCode ("CMS") to the Deploy Agent's own item for
 * that service, by matching against a live /api/services list — the only
 * safe source, since it's what the agent actually reports rather than a
 * guessed "o24-<name>" transformation. Sending BuildServiceCode directly as
 * a deploy request's `service` field (instead of the matched item's own
 * `code`, e.g. "o24-cms") is exactly the bug that made every redeploy/
 * rollback through /api/releases/[id]/deploy 404 with "service_not_found"
 * before ever reaching the agent's runDeploy — see that route's usage.
 */
export function resolveAgentServiceCode<T extends { code: string }>(
  items: T[],
  service: BuildServiceCode,
): T | undefined {
  return resolveAgentServiceCodeForProfile(ACTIVE_PROJECT_PROFILE.code, items, service)
}

export function resolveAgentServiceCodeForProfile<T extends { code: string }>(
  project: ProjectCode,
  items: T[],
  service: BuildServiceCode,
): T | undefined {
  if (!isServiceCodeForProfile(project, service)) return undefined
  return items.find((item) => githubServiceForAgentCodeForProfile(project, item.code) === service)
}
