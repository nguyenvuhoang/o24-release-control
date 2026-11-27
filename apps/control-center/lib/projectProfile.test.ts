import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getProjectProfile, resolveProjectCode } from './projectProfile'

test('resolveProjectCode defaults missing and empty values to IPS', () => {
  assert.equal(resolveProjectCode(), 'ips')
  assert.equal(resolveProjectCode(''), 'ips')
  assert.equal(resolveProjectCode('   '), 'ips')
})

test('resolveProjectCode normalizes supported project values', () => {
  assert.equal(resolveProjectCode(' IPS '), 'ips')
  assert.equal(resolveProjectCode(' W4S '), 'w4s')
})

test('resolveProjectCode rejects unsupported non-empty values', () => {
  assert.throws(
    () => resolveProjectCode('unknown'),
    (error: unknown) => error instanceof Error && error.message.includes('ips') && error.message.includes('w4s'),
  )
})

test('getProjectProfile exposes the immutable IPS catalog', () => {
  const profile = getProjectProfile('ips')
  assert.equal(profile.code, 'ips')
  assert.equal(profile.applicationName, 'IPS Release Control')
  assert.deepEqual(profile.services, ['CMS', 'WFO', 'IPS', 'CTH', 'NCH', 'RPT', 'LOG', 'DWH', 'PMT'])
  assert.equal(profile.imagePrefix, 'vknighthub/ips_o24')
  assert.equal(profile.configFile, 'environments.ips.json')
})

test('getProjectProfile exposes the immutable W4S catalog', () => {
  const profile = getProjectProfile('w4s')
  assert.equal(profile.code, 'w4s')
  assert.equal(profile.applicationName, 'W4S Release Control')
  assert.deepEqual(profile.services, ['WFO', 'LOG', 'CMS', 'CTH', 'W4S', 'NCH', 'PMT', 'AI'])
  assert.equal(profile.imagePrefix, 'vknighthub/w4s_o24')
  assert.equal(profile.configFile, 'environments.w4s.json')
})

// ACTIVE_PROJECT_PROFILE (this module's own top-level
// `getProjectProfile(resolveProjectCode(process.env.RELEASE_PROJECT))`) is
// imported into CLIENT components too — ServiceCard.tsx and
// useReleaseComparison.ts both import BUILD_SERVICES/
// githubServiceForAgentCode from lib/github/serviceMap.ts, which derives
// from this module. Next.js only inlines NEXT_PUBLIC_-prefixed vars into
// the browser bundle; a plain RELEASE_PROJECT read there is always
// `undefined`, so the client's own copy of this module silently resolves
// to 'ips' regardless of which deployment this actually is. For a w4s
// deployment that makes githubServiceForAgentCode('o24-w4s'/'o24-ai')
// return null ONLY in the browser (those two codes aren't IPS services),
// which is exactly what made ServiceCard.tsx hide Build, Latest Build and
// the version pipeline for W4S/AI in production while CTH/NCH/PMT (valid
// in both profiles) kept working by coincidence — verified live by
// loading the real dashboard. next.config.ts's `env` map is the fix: it
// inlines a build-time value into both server AND client bundles without
// needing a NEXT_PUBLIC_ rename. This test only guards against that entry
// being removed again; it cannot exercise the actual client bundle
// (nothing in this repo's test setup runs a bundler/browser). Reads the
// file as text rather than importing it: `node --test` resolves a
// `../` escape out of lib/ differently from a plain `node` invocation
// (reproduced independently of this file's content) and fails to load it.
test('next.config exposes RELEASE_PROJECT so the CLIENT bundle resolves the same project profile as the server', () => {
  const source = readFileSync(path.join(import.meta.dirname, '..', 'next.config.ts'), 'utf8')
  assert.match(
    source,
    /env:\s*\{[^}]*RELEASE_PROJECT:\s*process\.env\.RELEASE_PROJECT/,
    'next.config.ts must inline RELEASE_PROJECT via its `env` map so client-bundled code (ServiceCard.tsx, useReleaseComparison.ts, lib/github/serviceMap.ts) resolves the same project profile as the server',
  )
})
