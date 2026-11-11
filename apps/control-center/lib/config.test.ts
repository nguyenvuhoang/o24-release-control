import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { resolveControlConfigPath } from './config'
import { resolveProjectCode } from './projectProfile'

const cwd = path.join(path.sep, 'srv', 'release-control')

test('resolveControlConfigPath prefers an explicit absolute path', () => {
  assert.equal(resolveControlConfigPath(cwd, '/etc/o24/environments.json', 'w4s'), '/etc/o24/environments.json')
})

test('resolveControlConfigPath resolves an explicit relative path from cwd', () => {
  assert.equal(
    resolveControlConfigPath(cwd, 'custom/environments.json', 'w4s'),
    path.join(cwd, 'custom', 'environments.json'),
  )
})

test('resolveControlConfigPath selects the bundled profile config', () => {
  assert.equal(resolveControlConfigPath(cwd, undefined, 'ips'), path.join(cwd, 'config', 'environments.ips.json'))
  assert.equal(resolveControlConfigPath(cwd, undefined, 'w4s'), path.join(cwd, 'config', 'environments.w4s.json'))
})

test('resolveControlConfigPath defaults to IPS and invalid project values fail first', () => {
  assert.equal(resolveControlConfigPath(cwd), path.join(cwd, 'config', 'environments.ips.json'))
  assert.throws(() => resolveProjectCode('other'), /ips, w4s/)
})
