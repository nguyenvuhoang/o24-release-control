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
