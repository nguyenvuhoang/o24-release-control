import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ControlConfig, EnvironmentConfig } from './types'

const envPattern = /\$\{([A-Z0-9_]+)\}/g

function resolveEnvironmentVariables(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(envPattern, (_, name: string) => process.env[name] ?? '')
  }
  if (Array.isArray(value)) {
    return value.map(resolveEnvironmentVariables)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, resolveEnvironmentVariables(child)]),
    )
  }
  return value
}

export async function loadControlConfig(): Promise<ControlConfig> {
  const configPath = path.join(process.cwd(), 'config', 'environments.json')
  const raw = await fs.readFile(configPath, 'utf8')
  const parsed = resolveEnvironmentVariables(JSON.parse(raw)) as ControlConfig

  if (!Array.isArray(parsed.environments) || parsed.environments.length === 0) {
    throw new Error('No environments are configured')
  }

  const seen = new Set<string>()
  for (const environment of parsed.environments) {
    validateEnvironment(environment)
    if (seen.has(environment.code)) {
      throw new Error(`Duplicate environment code: ${environment.code}`)
    }
    seen.add(environment.code)
  }

  parsed.environments = parsed.environments
    .filter((environment) => environment.enabled !== false)
    .sort((a, b) => a.order - b.order)

  return parsed
}

function validateEnvironment(environment: EnvironmentConfig): void {
  if (!environment.code || !environment.name || !environment.baseUrl) {
    throw new Error('Each environment requires code, name and baseUrl')
  }
  if (!environment.apiKey || environment.apiSecret.length < 32) {
    throw new Error(`Environment ${environment.code} is missing a valid API key/secret`)
  }
  const url = new URL(environment.baseUrl)
  if (url.protocol !== 'https:' && process.env.ALLOW_HTTP_AGENTS !== 'true') {
    throw new Error(`Environment ${environment.code} must use HTTPS`)
  }
}

export async function getEnvironment(code: string): Promise<EnvironmentConfig> {
  const config = await loadControlConfig()
  const environment = config.environments.find((item) => item.code === code)
  if (!environment) {
    throw new Error(`Unknown environment: ${code}`)
  }
  return environment
}

export function getDataPath(fileName: string): string {
  const dataDir = process.env.CONTROL_DATA_DIR ?? '/data'
  return path.join(dataDir, fileName)
}
