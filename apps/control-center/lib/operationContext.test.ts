import test from 'node:test'
import assert from 'node:assert/strict'
import { clearReleaseOperationContext, getReleaseOperationContext, registerReleaseOperation } from './operationContext'

test('registerReleaseOperation round-trips through getReleaseOperationContext', () => {
  const context = {
    releaseId: 'release:CMS:digest:aaaa',
    service: 'CMS',
    environment: 'DEV',
    action: 'rollback' as const,
    toRepoDigest: `sha256:${'a'.repeat(64)}`,
    fromRepoDigest: `sha256:${'b'.repeat(64)}`,
  }
  registerReleaseOperation('op-test-1', context)
  assert.deepEqual(getReleaseOperationContext('op-test-1'), context)
})

test('getReleaseOperationContext returns undefined for an unknown operationId', () => {
  assert.equal(getReleaseOperationContext('op-never-registered'), undefined)
})

test('clearReleaseOperationContext removes the entry', () => {
  registerReleaseOperation('op-test-2', {
    releaseId: 'release:WFO:1:1',
    service: 'WFO',
    environment: 'UAT',
    action: 'redeploy',
    toRepoDigest: `sha256:${'c'.repeat(64)}`,
  })
  clearReleaseOperationContext('op-test-2')
  assert.equal(getReleaseOperationContext('op-test-2'), undefined)
})
