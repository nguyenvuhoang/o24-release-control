import assert from 'node:assert/strict'
import test from 'node:test'
import { decideApiAccess } from './apiAccess'

test('no session -> 401 unauthorized', () => {
  const decision = decideApiAccess(null)
  assert.deepEqual(decision, { allowed: false, status: 401, error: 'unauthorized' })
})

test('session with mustChangePassword=true, no bypass -> 403 password_change_required', () => {
  const decision = decideApiAccess({ mustChangePassword: true })
  assert.deepEqual(decision, { allowed: false, status: 403, error: 'password_change_required' })
})

test('session with mustChangePassword=true AND allowPasswordChangeRequired -> allowed', () => {
  const decision = decideApiAccess({ mustChangePassword: true }, { allowPasswordChangeRequired: true })
  assert.deepEqual(decision, { allowed: true })
})

test('a normal session (mustChangePassword=false) -> allowed, with or without the bypass option', () => {
  assert.deepEqual(decideApiAccess({ mustChangePassword: false }), { allowed: true })
  assert.deepEqual(decideApiAccess({ mustChangePassword: false }, { allowPasswordChangeRequired: true }), { allowed: true })
})
