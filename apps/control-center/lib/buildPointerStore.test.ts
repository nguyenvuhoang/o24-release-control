import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Backend selection (see buildPointerStore.ts / releaseRepository.ts /
// auditRepository.ts) falls to the file backend whenever KV isn't
// configured and we're not running on Vercel — exactly the state a plain
// `node --test` run has, as long as no ambient env vars say otherwise.
delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN
delete process.env.UPSTASH_REDIS_REST_URL
delete process.env.UPSTASH_REDIS_REST_TOKEN
delete process.env.VERCEL
process.env.CONTROL_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'o24-build-intent-test-'))

const {
  recordBuildIntent,
  getBuildIntent,
  getLatestBuildIntent,
  recordDispatchedRun,
  getLastDispatchedRun,
} = await import('./buildPointerStore')

test('recordBuildIntent stores an intent retrievable by runId', async () => {
  await recordBuildIntent({
    runId: 4242,
    service: 'CMS',
    branch: 'developer',
    tag: 'latest',
    requestedBy: 'alice',
    requestedAt: '2026-08-20T10:00:00.000Z',
  })

  const found = await getBuildIntent(4242)
  assert.deepEqual(found, {
    runId: 4242,
    service: 'CMS',
    branch: 'developer',
    tag: 'latest',
    requestedBy: 'alice',
    requestedAt: '2026-08-20T10:00:00.000Z',
  })
})

test('getBuildIntent returns undefined for an unknown runId', async () => {
  assert.equal(await getBuildIntent(999999), undefined)
})

test('getLatestBuildIntent returns the most recently requested intent for a service', async () => {
  await recordBuildIntent({
    runId: 1,
    service: 'WFO',
    branch: 'developer',
    tag: 'latest',
    requestedBy: 'alice',
    requestedAt: '2026-08-20T09:00:00.000Z',
  })
  await recordBuildIntent({
    runId: 2,
    service: 'WFO',
    branch: 'developer',
    tag: 'v2',
    requestedBy: 'bob',
    requestedAt: '2026-08-20T11:00:00.000Z',
  })
  await recordBuildIntent({
    runId: 3,
    service: 'WFO',
    branch: 'developer',
    tag: 'v1',
    requestedBy: 'carol',
    requestedAt: '2026-08-20T10:00:00.000Z',
  })

  const latest = await getLatestBuildIntent('WFO')
  assert.equal(latest?.runId, 2)
  assert.equal(latest?.requestedBy, 'bob')
})

test('getLatestBuildIntent returns undefined when no intent was ever recorded for the service', async () => {
  assert.equal(await getLatestBuildIntent('IPS'), undefined)
})

test('legacy build pointer (recordDispatchedRun / getLastDispatchedRun) still works unchanged', async () => {
  assert.equal(await getLastDispatchedRun('RPT'), undefined)
  await recordDispatchedRun('RPT', 777)
  assert.equal(await getLastDispatchedRun('RPT'), 777)
  // Overwrites, same as before this change.
  await recordDispatchedRun('RPT', 778)
  assert.equal(await getLastDispatchedRun('RPT'), 778)
})
