// Allow-list of services the build-o24.yml GitHub Actions workflow accepts as
// its `service` input. Kept as the single source of truth for build-related
// service validation — never duplicate this list elsewhere.
export const BUILD_SERVICES = ['CMS', 'WFO', 'IPS', 'CTH', 'NCH', 'RPT', 'LOG'] as const

export type BuildServiceCode = (typeof BUILD_SERVICES)[number]

export function isBuildServiceCode(value: string): value is BuildServiceCode {
  return (BUILD_SERVICES as readonly string[]).includes(value)
}

// The Docker Hub repository the workflow pushes each service's image to.
export function imageRepositoryFor(service: BuildServiceCode): string {
  return `vknighthub/ips_o24${service.toLowerCase()}`
}

// Deploy Agent service codes already follow the "o24-<name>" convention (see
// examples/server/agent-config.example.json — o24-wfo, o24-cms, ...), so the
// GitHub build service code is derived from it instead of maintaining a
// second, separately-hardcoded service catalog.
export function githubServiceForAgentCode(agentServiceCode: string): BuildServiceCode | null {
  const match = /^o24-([a-z0-9]+)$/i.exec(agentServiceCode)
  if (!match) return null
  const candidate = match[1].toUpperCase()
  return isBuildServiceCode(candidate) ? candidate : null
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
export function resolveAgentServiceCode<T extends { code: string }>(items: T[], service: BuildServiceCode): T | undefined {
  return items.find((item) => githubServiceForAgentCode(item.code) === service)
}
