import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { resolveControlConfigPath } from './config'

test('resolveControlConfigPath prefers an explicit absolute path', () => {
  const cwd = path.resolve('test-workspace')
  const explicitPath = path.resolve('etc', 'o24', 'environments.json')

  assert.equal(
    resolveControlConfigPath(cwd, explicitPath),
    explicitPath,
  )
})

test('resolveControlConfigPath resolves an explicit relative path from cwd', () => {
  const cwd = path.resolve('test-workspace')
  const explicitPath = path.join('custom', 'environments.json')

  assert.equal(
    resolveControlConfigPath(cwd, explicitPath),
    path.resolve(cwd, explicitPath),
  )
})