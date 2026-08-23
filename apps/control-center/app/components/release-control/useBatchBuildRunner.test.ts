import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveSkippedOnCancel } from './useBatchBuildRunner'

test('deriveSkippedOnCancel turns every pending entry into skipped', () => {
  const result = deriveSkippedOnCancel({ CMS: 'started', WFO: 'pending', IPS: 'pending' })
  assert.deepEqual(result, { CMS: 'started', WFO: 'skipped', IPS: 'skipped' })
})

test('deriveSkippedOnCancel never touches an already-started or already-skipped entry', () => {
  const result = deriveSkippedOnCancel({ CMS: 'started', NCH: 'skipped' })
  assert.deepEqual(result, { CMS: 'started', NCH: 'skipped' })
})

test('deriveSkippedOnCancel on an empty queue returns an empty object', () => {
  assert.deepEqual(deriveSkippedOnCancel({}), {})
})
