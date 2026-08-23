import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyCompareStatus } from './compare'

test('classifyCompareStatus recognizes all 4 documented GitHub compare statuses', () => {
  assert.equal(classifyCompareStatus('identical'), 'identical')
  assert.equal(classifyCompareStatus('ahead'), 'ahead')
  assert.equal(classifyCompareStatus('behind'), 'behind')
  assert.equal(classifyCompareStatus('diverged'), 'diverged')
})

test('classifyCompareStatus throws rather than silently mislabeling an unrecognized status', () => {
  assert.throws(() => classifyCompareStatus('something-new'), /Unrecognized GitHub compare status/)
})
