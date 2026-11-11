export const PROJECT_CODES = ['ips', 'w4s'] as const

export type ProjectCode = (typeof PROJECT_CODES)[number]

export const ALL_SERVICE_CODES = [
  'CMS',
  'WFO',
  'IPS',
  'CTH',
  'NCH',
  'RPT',
  'LOG',
  'DWH',
  'PMT',
  'W4S',
  'AI',
] as const

export type ServiceCode = (typeof ALL_SERVICE_CODES)[number]

export type ProjectProfile = Readonly<{
  code: ProjectCode
  applicationName: string
  services: readonly ServiceCode[]
  imagePrefix: string
  configFile: string
}>

const PROJECT_PROFILES: Readonly<Record<ProjectCode, ProjectProfile>> = Object.freeze({
  ips: Object.freeze({
    code: 'ips',
    applicationName: 'IPS Release Control',
    services: Object.freeze(['CMS', 'WFO', 'IPS', 'CTH', 'NCH', 'RPT', 'LOG', 'DWH', 'PMT'] as const),
    imagePrefix: 'vknighthub/ips_o24',
    configFile: 'environments.ips.json',
  }),
  w4s: Object.freeze({
    code: 'w4s',
    applicationName: 'W4S Release Control',
    services: Object.freeze(['WFO', 'LOG', 'CMS', 'CTH', 'W4S', 'NCH', 'PMT', 'AI'] as const),
    imagePrefix: 'vknighthub/w4s_o24',
    configFile: 'environments.w4s.json',
  }),
})

export function resolveProjectCode(value?: string): ProjectCode {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return 'ips'
  if (normalized === 'ips' || normalized === 'w4s') return normalized
  throw new Error(`Invalid RELEASE_PROJECT "${value}". Expected one of: ${PROJECT_CODES.join(', ')}`)
}

export function getProjectProfile(code: ProjectCode = resolveProjectCode(process.env.RELEASE_PROJECT)): ProjectProfile {
  return PROJECT_PROFILES[code]
}

export const ACTIVE_PROJECT_PROFILE = getProjectProfile()
