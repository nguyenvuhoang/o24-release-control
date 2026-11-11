import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILD_SERVICES,
  githubServiceForAgentCode,
  githubServiceForAgentCodeForProfile,
  imageRepositoryForProfile,
  isBuildServiceCode,
  isServiceCodeForProfile,
  resolveAgentServiceCode,
  resolveAgentServiceCodeForProfile,
  serviceCodesForProfile,
} from './serviceMap'

// ---- githubServiceForAgentCode ----

test('githubServiceForAgentCode maps the real agent-config service codes to their BuildServiceCode', () => {
  assert.equal(githubServiceForAgentCode('o24-cms'), 'CMS')
  assert.equal(githubServiceForAgentCode('o24-wfo'), 'WFO')
  assert.equal(githubServiceForAgentCode('O24-CMS'), 'CMS')
})

test('githubServiceForAgentCode returns null for anything not in the o24-<name> convention or not a known BuildServiceCode', () => {
  assert.equal(githubServiceForAgentCode('CMS'), null)
  assert.equal(githubServiceForAgentCode('cms'), null)
  assert.equal(githubServiceForAgentCode('o24-notreal'), null)
  assert.equal(githubServiceForAgentCode(''), null)
})

// ---- resolveAgentServiceCode ----
//
// Reproduces the exact real payload from the 2026-08-22 23:28 (16:28 UTC)
// CMS deploy failure: a live /api/services list carrying the agent's own
// "o24-cms" code, and a ReleaseSnapshot whose `service` field is the
// BuildServiceCode "CMS" — the two were never the same string, and sending
// the BuildServiceCode directly to the agent's /api/deploy always 404'd
// with "service_not_found" (audit error: "DEV: Not Found") before an
// operation was ever created, before any .env.deploy write, before any
// container recreate.

const REAL_DEV_SERVICES = [
  { code: 'o24-cms', repoDigest: 'sha256:' + 'd'.repeat(64) },
  { code: 'o24-wfo', repoDigest: 'sha256:' + 'a'.repeat(64) },
  { code: 'o24-ips', repoDigest: 'sha256:' + 'b'.repeat(64) },
]

test('resolveAgentServiceCode finds the agent\'s own item ("o24-cms") for BuildServiceCode "CMS", never the BuildServiceCode itself', () => {
  const matched = resolveAgentServiceCode(REAL_DEV_SERVICES, 'CMS')
  assert.ok(matched)
  assert.equal(matched.code, 'o24-cms')
  assert.notEqual(matched.code, 'CMS')
})

test('resolveAgentServiceCode returns undefined (never a guessed code) when nothing in the live list matches', () => {
  const matched = resolveAgentServiceCode(REAL_DEV_SERVICES, 'NCH')
  assert.equal(matched, undefined)
})

test('resolveAgentServiceCode is case-sensitive on BuildServiceCode: it will not match a lowercase or mistyped service', () => {
  const withOnlyUpper = resolveAgentServiceCode(REAL_DEV_SERVICES, 'CMS')
  assert.equal(withOnlyUpper?.code, 'o24-cms')
  // isBuildServiceCode guards the input type — a caller can never even
  // construct a 'cms' BuildServiceCode to pass in.
  assert.equal(isBuildServiceCode('cms'), false)
})

test('every BUILD_SERVICES code resolves to its real agent-config counterpart, round-tripping through both directions', () => {
  const allServices = BUILD_SERVICES.map((service) => ({ code: `o24-${service.toLowerCase()}` }))
  for (const item of allServices) {
    const buildCode = githubServiceForAgentCode(item.code)
    assert.ok(buildCode, `expected ${item.code} to map to a BuildServiceCode`)
    const resolved = resolveAgentServiceCode(allServices, buildCode!)
    assert.equal(resolved?.code, item.code)
  }
})

test('profile-bound service catalogs retain the exact IPS and W4S order', () => {
  assert.deepEqual(serviceCodesForProfile('ips'), ['CMS', 'WFO', 'IPS', 'CTH', 'NCH', 'RPT', 'LOG', 'DWH', 'PMT'])
  assert.deepEqual(serviceCodesForProfile('w4s'), ['WFO', 'LOG', 'CMS', 'CTH', 'W4S', 'NCH', 'PMT', 'AI'])
})

test('profile-bound image repositories use only their project namespace', () => {
  assert.equal(imageRepositoryForProfile('ips', 'CMS'), 'vknighthub/ips_o24cms')
  assert.equal(imageRepositoryForProfile('w4s', 'CMS'), 'vknighthub/w4s_o24cms')
  assert.equal(imageRepositoryForProfile('w4s', 'W4S'), 'vknighthub/w4s_o24w4s')
  assert.equal(imageRepositoryForProfile('w4s', 'AI'), 'vknighthub/w4s_o24ai')
})

test('profile-bound validation rejects services from the other project', () => {
  for (const service of ['IPS', 'RPT', 'DWH']) assert.equal(isServiceCodeForProfile('w4s', service), false)
  for (const service of ['W4S', 'AI']) assert.equal(isServiceCodeForProfile('ips', service), false)
  assert.equal(isServiceCodeForProfile('w4s', 'PMT'), true)
})

test('every W4S agent code round-trips only through the W4S profile', () => {
  const services = serviceCodesForProfile('w4s').map((service) => ({ code: `o24-${service.toLowerCase()}` }))
  for (const item of services) {
    const buildCode = githubServiceForAgentCodeForProfile('w4s', item.code)
    assert.ok(buildCode)
    assert.equal(resolveAgentServiceCodeForProfile('w4s', services, buildCode)?.code, item.code)
  }
  assert.equal(githubServiceForAgentCodeForProfile('w4s', 'o24-ips'), null)
})
