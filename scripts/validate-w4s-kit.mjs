import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const kitDir = path.join(repoRoot, 'examples', 'w4s', 'server')
const expectedServices = ['WFO', 'LOG', 'CMS', 'CTH', 'W4S', 'NCH', 'PMT', 'AI']
const environments = ['DEV', 'UAT', 'PROD']

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertUnique(values, field, environment) {
  assert(new Set(values).size === values.length, `${environment}: duplicate ${field}`)
}

const composePath = path.join(kitDir, 'docker-compose.application.fragment.yml')
const compose = await readFile(composePath, 'utf8')

for (const environment of environments) {
  const file = path.join(kitDir, `agent-config.${environment.toLowerCase()}.example.json`)
  const config = JSON.parse(await readFile(file, 'utf8'))
  assert(config.environment === environment, `${environment}: invalid environment value`)
  assert(config.imageCleanupEnabled === true, `${environment}: image cleanup must be enabled`)
  assert(config.imageCleanupMinAgeHours === 24, `${environment}: image cleanup minimum age must be 24 hours`)
  assert(Array.isArray(config.services), `${environment}: services must be an array`)

  const serviceCodes = config.services.map((service) => service.code.replace(/^o24-/, '').toUpperCase())
  assert(JSON.stringify(serviceCodes) === JSON.stringify(expectedServices), `${environment}: service order/catalog mismatch`)
  assertUnique(config.services.map((service) => service.code), 'service code', environment)
  assertUnique(config.services.map((service) => service.composeService), 'compose service', environment)
  assertUnique(config.services.map((service) => service.containerName), 'container name', environment)
  assertUnique(config.services.map((service) => service.imageEnvKey), 'image environment key', environment)

  for (const [index, service] of config.services.entries()) {
    const code = expectedServices[index]
    const lower = code.toLowerCase()
    assert(service.code === `o24-${lower}`, `${environment}/${code}: invalid agent code`)
    assert(service.composeService === `o24-${lower}`, `${environment}/${code}: invalid compose service`)
    assert(service.containerName === `o24-${lower}`, `${environment}/${code}: invalid container name`)
    assert(service.imageRepository === `vknighthub/w4s_o24${lower}`, `${environment}/${code}: invalid image repository`)
    assert(service.imageEnvKey === `O24_${code}_IMAGE`, `${environment}/${code}: invalid image env key`)
    assert(service.healthTimeoutSeconds === 90, `${environment}/${code}: health timeout must be 90 seconds`)
    assert(new RegExp(`^  o24-${lower}:`, 'm').test(compose), `${environment}/${code}: compose service is missing`)
    assert(compose.includes(`image: \${O24_${code}_IMAGE}`), `${environment}/${code}: compose image variable is missing`)
  }

  console.log(`${environment}: ${config.services.length} services valid`)
}

const kitFiles = [
  '.env.agent.example',
  '.env.deploy.example',
  'docker-compose.agent.yml',
  'docker-compose.application.fragment.yml',
  'cloudflared-config.example.yml',
  ...environments.map((environment) => `agent-config.${environment.toLowerCase()}.example.json`),
]

for (const fileName of kitFiles) {
  const content = await readFile(path.join(kitDir, fileName), 'utf8')
  assert(!content.includes('vknighthub/ips_o24'), `${fileName}: contains an IPS image repository`)
  assert(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content), `${fileName}: contains a private key`)
  assert(!/\b(?:ghp|github_pat|dckr_pat)_[A-Za-z0-9_]{16,}\b/.test(content), `${fileName}: contains a token-like value`)
  assert(!/\b[0-9a-f]{48,}\b/i.test(content), `${fileName}: contains a secret-like hexadecimal value`)
}

console.log('W4S deployment kit is valid')
