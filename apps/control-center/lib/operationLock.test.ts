import test from 'node:test'
import assert from 'node:assert/strict'
import { isOperationLocked, releaseOperationLock, tryAcquireOperationLock } from './operationLock'

test('tryAcquireOperationLock rejects a second concurrent operation on the same service+environment', () => {
  assert.equal(tryAcquireOperationLock('DEV', 'CMS'), true)
  assert.equal(isOperationLocked('DEV', 'CMS'), true)
  assert.equal(tryAcquireOperationLock('DEV', 'CMS'), false)
})

test('releaseOperationLock allows a new operation to acquire the lock afterwards', () => {
  assert.equal(tryAcquireOperationLock('UAT', 'WFO'), true)
  assert.equal(tryAcquireOperationLock('UAT', 'WFO'), false)
  releaseOperationLock('UAT', 'WFO')
  assert.equal(isOperationLocked('UAT', 'WFO'), false)
  assert.equal(tryAcquireOperationLock('UAT', 'WFO'), true)
})

test('locks are independent per service+environment key', () => {
  assert.equal(tryAcquireOperationLock('DEV', 'IPS'), true)
  // Different service, same environment — must not be blocked.
  assert.equal(tryAcquireOperationLock('DEV', 'CTH'), true)
  // Same service, different environment — must not be blocked.
  assert.equal(tryAcquireOperationLock('UAT', 'IPS'), true)
})
