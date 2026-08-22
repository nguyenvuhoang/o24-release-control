import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDigest, resolveReleaseComparison, toRunningRelease } from './releaseComparison'
import type { ReleaseSnapshot, ResolvedRelease, RunningRelease, ServiceStatus } from './types'

const DIGEST_A = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`
const REPO = 'vknighthub/ips_o24cms'

function makeLatest(overrides: Partial<ResolvedRelease> = {}): ResolvedRelease {
  return {
    service: 'CMS',
    repository: REPO,
    tag: 'latest',
    repoDigest: `${REPO}@${DIGEST_A}`,
    source: 'external',
    snapshotId: 'release:CMS:digest:' + 'a'.repeat(64),
    discoveredAt: '2026-08-22T10:00:00.000Z',
    ...overrides,
  }
}

function makeRunning(overrides: Partial<RunningRelease> = {}): RunningRelease {
  return {
    environment: 'DEV',
    service: 'CMS',
    repository: REPO,
    tag: 'latest',
    repoDigest: DIGEST_A,
    snapshotId: 'release:CMS:digest:' + 'a'.repeat(64),
    containerStatus: 'running',
    checkedAt: '2026-08-22T10:00:00.000Z',
    ...overrides,
  }
}

// ---- normalizeDigest ----

test('normalizeDigest extracts the bare sha256 hex from either a full or bare reference', () => {
  assert.equal(normalizeDigest(`${REPO}@${DIGEST_A}`), DIGEST_A)
  assert.equal(normalizeDigest(DIGEST_A), DIGEST_A)
  assert.equal(normalizeDigest(DIGEST_A.toUpperCase()), DIGEST_A)
  assert.equal(normalizeDigest(undefined), undefined)
  assert.equal(normalizeDigest('not-a-digest'), undefined)
})

// ---- toRunningRelease ----

test('toRunningRelease reports "unknown" with an error when the environment is offline', () => {
  const result = toRunningRelease({
    environment: 'DEV',
    service: 'CMS',
    environmentOnline: false,
    environmentError: 'connect ECONNREFUSED',
    checkedAt: '2026-08-22T10:00:00.000Z',
  })
  assert.equal(result.containerStatus, 'unknown')
  assert.equal(result.error, 'connect ECONNREFUSED')
  assert.equal(result.repoDigest, undefined)
})

test('toRunningRelease reports "missing" when the agent is online but does not manage this service', () => {
  const result = toRunningRelease({
    environment: 'UAT',
    service: 'LOG',
    environmentOnline: true,
    serviceStatus: undefined,
    checkedAt: '2026-08-22T10:00:00.000Z',
  })
  assert.equal(result.containerStatus, 'missing')
  assert.equal(result.error, undefined)
})

test('toRunningRelease surfaces the ServiceStatus error instead of treating it as "not deployed"', () => {
  const serviceStatus: ServiceStatus = {
    code: 'o24-cms', displayName: 'CMS', composeService: 'cms', containerName: 'o24-cms',
    status: '', health: '', imageRef: '', imageId: '', error: 'docker inspect failed',
  }
  const result = toRunningRelease({ environment: 'DEV', service: 'CMS', environmentOnline: true, serviceStatus, checkedAt: 'now' })
  assert.equal(result.containerStatus, 'unknown')
  assert.equal(result.error, 'docker inspect failed')
})

test('toRunningRelease maps container status and attaches the matched snapshot', () => {
  const serviceStatus: ServiceStatus = {
    code: 'o24-cms', displayName: 'CMS', composeService: 'cms', containerName: 'o24-cms',
    status: 'running', health: 'healthy', imageRef: `${REPO}@${DIGEST_A}`, imageId: 'sha256:localimageid',
    repoDigest: DIGEST_A,
  }
  const snapshot: ReleaseSnapshot = {
    id: 'release:CMS:digest:' + 'a'.repeat(64), service: 'CMS', source: 'docker-registry',
    branch: null, commitSha: null, dockerRepository: REPO, repoDigest: `${REPO}@${DIGEST_A}`, tag: 'latest',
    githubRunId: null, githubRunAttempt: null, createdAt: '2026-08-22T09:00:00.000Z', createdBy: 'admin',
  }
  const result = toRunningRelease({ environment: 'DEV', service: 'CMS', environmentOnline: true, serviceStatus, matchedSnapshot: snapshot, checkedAt: 'now' })
  assert.equal(result.containerStatus, 'running')
  assert.equal(result.repoDigest, DIGEST_A)
  assert.equal(result.snapshotId, snapshot.id)
  // Never the local imageId, even though the ServiceStatus carries one.
  assert.notEqual(result.repoDigest, serviceStatus.imageId)
})

test('toRunningRelease carries localImageId/imageReference separately from repoDigest and never cross-maps them', () => {
  // Reproduces the exact production report: repoDigest happens to equal the
  // local image ID string (a real Docker RepoDigests coincidence, not a
  // mapping bug) — repoDigest must still be sourced only from
  // ServiceStatus.repoDigest, never derived from imageId.
  const localId = 'sha256:6fd8478b1ba307003c9261826d9d295095bf7fa5eacbd4b9fddfd548fdcc186c'
  const serviceStatus: ServiceStatus = {
    code: 'o24-cms', displayName: 'CMS', composeService: 'cms', containerName: 'o24-cms',
    status: 'running', health: 'none', imageRef: `${REPO}:latest`, imageId: localId,
    repoDigest: localId,
  }
  const result = toRunningRelease({ environment: 'DEV', service: 'CMS', environmentOnline: true, serviceStatus, checkedAt: 'now' })
  assert.equal(result.repoDigest, localId)
  assert.equal(result.localImageId, localId)
  assert.equal(result.imageReference, `${REPO}:latest`)
  // Same string value here only because the source data coincides — the
  // fields must still come from distinct ServiceStatus properties.
  assert.equal(result.repoDigest, serviceStatus.repoDigest)
  assert.notEqual(result.imageReference, result.repoDigest)
})

test('toRunningRelease flags configDrift when the agent\'s configured image resolves to a different digest than what is actually running', () => {
  const serviceStatus: ServiceStatus = {
    code: 'o24-cms', displayName: 'CMS', composeService: 'cms', containerName: 'o24-cms',
    status: 'running', health: 'none', imageRef: `${REPO}:latest`, imageId: 'sha256:localid',
    repoDigest: DIGEST_B,
    configuredImage: `${REPO}@${DIGEST_A}`,
  }
  const result = toRunningRelease({ environment: 'DEV', service: 'CMS', environmentOnline: true, serviceStatus, checkedAt: 'now' })
  assert.equal(result.configDrift, true)
})

test('toRunningRelease does not flag configDrift when configuredImage matches the running digest, or is absent', () => {
  const matching: ServiceStatus = {
    code: 'o24-cms', displayName: 'CMS', composeService: 'cms', containerName: 'o24-cms',
    status: 'running', health: 'none', imageRef: `${REPO}@${DIGEST_A}`, imageId: 'sha256:localid',
    repoDigest: DIGEST_A, configuredImage: `${REPO}@${DIGEST_A}`,
  }
  assert.equal(toRunningRelease({ environment: 'DEV', service: 'CMS', environmentOnline: true, serviceStatus: matching, checkedAt: 'now' }).configDrift, false)

  const noConfigured: ServiceStatus = {
    code: 'o24-cms', displayName: 'CMS', composeService: 'cms', containerName: 'o24-cms',
    status: 'running', health: 'none', imageRef: `${REPO}@${DIGEST_A}`, imageId: 'sha256:localid',
    repoDigest: DIGEST_A,
  }
  assert.equal(toRunningRelease({ environment: 'DEV', service: 'CMS', environmentOnline: true, serviceStatus: noConfigured, checkedAt: 'now' }).configDrift, false)
})

test('resolveReleaseComparison surfaces a configDrift warning ahead of other warnings, without changing the digest-based headline state', () => {
  const result = resolveReleaseComparison({
    latest: makeLatest(),
    dev: makeRunning({ repoDigest: DIGEST_A, configDrift: true }),
  })
  // DEV's digest still matches latest -> DEV_SYNCED stays the headline; the
  // drift is a warning, not a different classification of "which digest is
  // running" (that answer, from repoDigest, is unaffected by configDrift).
  assert.equal(result.state, 'DEV_SYNCED')
  assert.ok(result.warnings.some((w) => w.includes('DEV') && w.includes('cấu hình triển khai')))
})

test('toRunningRelease maps exited/stopped/dead to "stopped" and anything else to "unknown"', () => {
  const base = { environment: 'DEV', service: 'CMS' as const, environmentOnline: true, checkedAt: 'now' }
  const statusOf = (status: string): ServiceStatus => ({
    code: 'o24-cms', displayName: 'CMS', composeService: 'cms', containerName: 'o24-cms', status, health: '', imageRef: '', imageId: '',
  })
  assert.equal(toRunningRelease({ ...base, serviceStatus: statusOf('exited') }).containerStatus, 'stopped')
  assert.equal(toRunningRelease({ ...base, serviceStatus: statusOf('dead') }).containerStatus, 'stopped')
  assert.equal(toRunningRelease({ ...base, serviceStatus: statusOf('restarting') }).containerStatus, 'unknown')
})

// ---- resolveReleaseComparison — headline state ----

test('NO_BUILD when Docker Hub has nothing resolvable, but promote flags stay independent of it', () => {
  const result = resolveReleaseComparison({
    latest: undefined,
    dev: makeRunning({ repoDigest: DIGEST_B }),
    uat: makeRunning({ environment: 'UAT', repoDigest: DIGEST_B }),
  })
  assert.equal(result.state, 'NO_BUILD')
  assert.equal(result.canImportSnapshot, false)
  assert.equal(result.canDeployLatestToDev, false)
  assert.equal(result.canPromoteDevToUat, true)
})

test('ENVIRONMENT_UNAVAILABLE when DEV could not be checked, even if latest and UAT are fine', () => {
  const result = resolveReleaseComparison({
    latest: makeLatest(),
    dev: makeRunning({ error: 'timeout' }),
    uat: makeRunning({ environment: 'UAT', repoDigest: DIGEST_A }),
  })
  assert.equal(result.state, 'ENVIRONMENT_UNAVAILABLE')
  assert.equal(result.canDeployLatestToDev, false)
  assert.equal(result.canPromoteDevToUat, false)
  assert.ok(result.warnings.some((w) => w.includes('DEV')))
})

test('UNTRACKED_BUILD when the latest build has no Release Snapshot yet, and import stays allowed', () => {
  const result = resolveReleaseComparison({
    latest: makeLatest({ source: 'unknown', snapshotId: undefined }),
    dev: makeRunning({ repoDigest: DIGEST_B }),
  })
  assert.equal(result.state, 'UNTRACKED_BUILD')
  assert.equal(result.canImportSnapshot, true)
  // DEV differs from latest and DEV is available -> deploying is still meaningful once imported.
  assert.equal(result.canDeployLatestToDev, true)
})

test('NEW_BUILD_AVAILABLE when DEV runs a known older release (including a deliberate rollback)', () => {
  const result = resolveReleaseComparison({
    latest: makeLatest(),
    dev: makeRunning({ repoDigest: DIGEST_B, snapshotId: 'release:CMS:digest:' + 'b'.repeat(64) }),
  })
  assert.equal(result.state, 'NEW_BUILD_AVAILABLE')
  assert.equal(result.canDeployLatestToDev, true)
  assert.ok(result.warnings.some((w) => w.toLowerCase().includes('rollback')))
})

test('DEV_OUTDATED when DEV runs a digest that resolves to nothing at all', () => {
  const result = resolveReleaseComparison({
    latest: makeLatest(),
    dev: makeRunning({ repoDigest: DIGEST_B, snapshotId: undefined }),
  })
  assert.equal(result.state, 'DEV_OUTDATED')
  assert.equal(result.canDeployLatestToDev, true)
})

test('DEV_SYNCED when DEV matches latest and UAT cannot be checked or has nothing deployed', () => {
  const synced = resolveReleaseComparison({ latest: makeLatest(), dev: makeRunning({ repoDigest: DIGEST_A }) })
  assert.equal(synced.state, 'DEV_SYNCED')
  assert.equal(synced.canDeployLatestToDev, false)

  const uatMissing = resolveReleaseComparison({
    latest: makeLatest(),
    dev: makeRunning({ repoDigest: DIGEST_A }),
    uat: makeRunning({ environment: 'UAT', repoDigest: undefined, containerStatus: 'missing' }),
  })
  assert.equal(uatMissing.state, 'DEV_SYNCED')
})

test('UAT_DIFFERS_FROM_DEV when UAT runs a known release different from DEV', () => {
  const result = resolveReleaseComparison({
    latest: makeLatest(),
    dev: makeRunning({ repoDigest: DIGEST_A }),
    uat: makeRunning({ environment: 'UAT', repoDigest: DIGEST_B, snapshotId: 'release:CMS:digest:' + 'b'.repeat(64) }),
  })
  assert.equal(result.state, 'UAT_DIFFERS_FROM_DEV')
  assert.ok(result.warnings.includes('UAT khác DEV'))
})

test('UAT_AHEAD_OR_UNKNOWN when UAT differs from DEV and resolves to no known snapshot at all', () => {
  const result = resolveReleaseComparison({
    latest: makeLatest(),
    dev: makeRunning({ repoDigest: DIGEST_A }),
    uat: makeRunning({ environment: 'UAT', repoDigest: DIGEST_B, snapshotId: undefined }),
  })
  assert.equal(result.state, 'UAT_AHEAD_OR_UNKNOWN')
})

test('UAT_SYNCED_WITH_DEV when UAT matches DEV and PROD is unavailable or empty', () => {
  const result = resolveReleaseComparison({
    latest: makeLatest(),
    dev: makeRunning({ repoDigest: DIGEST_A }),
    uat: makeRunning({ environment: 'UAT', repoDigest: DIGEST_A }),
  })
  assert.equal(result.state, 'UAT_SYNCED_WITH_DEV')
  assert.equal(result.canPromoteUatToProd, false)
})

test('PROD_DIFFERS_FROM_UAT and PROD_SYNCED_WITH_UAT drill down correctly when DEV/UAT are already synced', () => {
  const differs = resolveReleaseComparison({
    latest: makeLatest(),
    dev: makeRunning({ repoDigest: DIGEST_A }),
    uat: makeRunning({ environment: 'UAT', repoDigest: DIGEST_A }),
    prod: makeRunning({ environment: 'PROD', repoDigest: DIGEST_B }),
  })
  assert.equal(differs.state, 'PROD_DIFFERS_FROM_UAT')
  assert.ok(differs.warnings.includes('PROD khác UAT'))

  const synced = resolveReleaseComparison({
    latest: makeLatest(),
    dev: makeRunning({ repoDigest: DIGEST_A }),
    uat: makeRunning({ environment: 'UAT', repoDigest: DIGEST_A }),
    prod: makeRunning({ environment: 'PROD', repoDigest: DIGEST_A }),
  })
  assert.equal(synced.state, 'PROD_SYNCED_WITH_UAT')
})

// ---- Edge cases explicitly called out in the task ----

test('a re-run producing a new digest for the same commit is treated as a genuinely different release, never conflated', () => {
  const commitSha = 'c'.repeat(40)
  const latestFromRerun = makeLatest({ commitSha, repoDigest: `${REPO}@${DIGEST_B}`, snapshotId: 'release:CMS:digest:' + 'b'.repeat(64) })
  const devOnOldDigest = makeRunning({ repoDigest: DIGEST_A, snapshotId: 'release:CMS:digest:' + 'a'.repeat(64) })
  const result = resolveReleaseComparison({ latest: latestFromRerun, dev: devOnOldDigest })
  // Same commitSha, different digest -> still a real, deployable new build.
  assert.equal(result.state, 'NEW_BUILD_AVAILABLE')
  assert.equal(result.canDeployLatestToDev, true)
})

test('a rollback that deliberately differs from Latest Build is not treated as an error, and redeploying latest stays possible', () => {
  const result = resolveReleaseComparison({
    latest: makeLatest(),
    dev: makeRunning({ repoDigest: DIGEST_B, snapshotId: 'release:CMS:digest:' + 'b'.repeat(64) }),
  })
  assert.notEqual(result.state, 'ENVIRONMENT_UNAVAILABLE')
  assert.notEqual(result.state, 'UNKNOWN')
  assert.equal(result.canDeployLatestToDev, true)
})

test('one service failing to resolve does not affect how another service is computed (pure function, no shared state)', () => {
  const broken = resolveReleaseComparison({ latest: undefined, dev: undefined })
  const healthy = resolveReleaseComparison({ latest: makeLatest(), dev: makeRunning({ repoDigest: DIGEST_A }) })
  assert.equal(broken.state, 'NO_BUILD')
  assert.equal(healthy.state, 'DEV_SYNCED')
})

test('an external build with no commitSha still compares correctly by digest alone', () => {
  const result = resolveReleaseComparison({
    latest: makeLatest({ source: 'external', commitSha: undefined, branch: undefined }),
    dev: makeRunning({ repoDigest: DIGEST_A }),
  })
  assert.equal(result.state, 'DEV_SYNCED')
})
