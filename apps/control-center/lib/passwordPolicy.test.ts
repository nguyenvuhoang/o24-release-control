import assert from 'node:assert/strict'
import test from 'node:test'
import bcrypt from 'bcryptjs'
import { validateNewPassword, validateNewPasswordShape } from './passwordPolicy'

test('rejects a password shorter than 8 characters', () => {
  const result = validateNewPasswordShape('short1', 'short1', 'linhnq')
  assert.equal(result.ok, false)
})

test('rejects when confirmPassword does not match', () => {
  const result = validateNewPasswordShape('longenoughpw', 'different', 'linhnq')
  assert.equal(result.ok, false)
})

test('rejects a new password equal to the username (case-insensitive)', () => {
  const result = validateNewPasswordShape('LinhNQ', 'LinhNQ', 'linhnq')
  assert.equal(result.ok, false)
})

test('accepts a valid, sufficiently different new password (shape-only check)', () => {
  const result = validateNewPasswordShape('a-real-new-password', 'a-real-new-password', 'linhnq')
  assert.equal(result.ok, true)
})

test('validateNewPassword accepts a password that differs from the old one, even if the old one equaled the username', async () => {
  const currentHash = await bcrypt.hash('linhnq', 4)
  const result = await validateNewPassword('a-genuinely-different-password', 'a-genuinely-different-password', 'linhnq', currentHash)
  assert.equal(result.ok, true)
})

test('validateNewPassword rejects when the new password bcrypt-matches the stored (old) hash', async () => {
  const currentHash = await bcrypt.hash('the-current-password', 4)
  const result = await validateNewPassword('the-current-password', 'the-current-password', 'linhnq', currentHash)
  assert.equal(result.ok, false)
})

test('validateNewPassword accepts a genuinely new, valid password', async () => {
  const currentHash = await bcrypt.hash('the-current-password', 4)
  const result = await validateNewPassword('a-brand-new-password', 'a-brand-new-password', 'linhnq', currentHash)
  assert.equal(result.ok, true)
})
