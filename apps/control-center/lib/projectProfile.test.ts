import test from 'node:test'
import assert from 'node:assert/strict'
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
