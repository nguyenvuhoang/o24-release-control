import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyLatestRelease, resolveLatestRelease } from './latestReleaseResolver'
import type { BuildIntent, BuildRunSnapshot, DockerHubTagInfo, ReleaseSnapshot } from './types'

const dockerHub: DockerHubTagInfo = {
  repoDigest: `vknighthub/ips_o24cms@sha256:${'a'.repeat(64)}`,
  tag: 'latest',
  lastUpdated: '2026-08-22T00:00:00.000Z',
}

function makeSnapshot(overrides: Partial<ReleaseSnapshot> = {}): ReleaseSnapshot {
  return {
    id: 'release:CMS:digest:' + 'a'.repeat(64),
    service: 'CMS',
    source: 'docker-registry',
    branch: null,
    commitSha: null,
    dockerRepository: 'vknighthub/ips_o24cms',
    repoDigest: dockerHub.repoDigest,
    tag: 'latest',
    githubRunId: null,
    githubRunAttempt: null,
    createdAt: '2026-08-22T00:00:00.000Z',
    createdBy: 'admin',
    ...overrides,
  }
}

function makeGithubRun(overrides: Partial<BuildRunSnapshot> = {}): BuildRunSnapshot {
  return {
    runId: 4242,
    status: 'completed',
    conclusion: 'success',
    htmlUrl: 'https://github.com/nguyenvuhoang/w4s/actions/runs/4242',
    branch: 'developer',
    commitSha: 'b'.repeat(40),
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:05:00.000Z',
    ...overrides,
  }
}

function makeBuildIntent(overrides: Partial<BuildIntent> = {}): BuildIntent {
  return {
    runId: 4242,
    service: 'CMS',
    branch: 'developer',
    tag: 'latest',
    requestedBy: 'admin',
    requestedAt: '2026-08-21T23:00:00.000Z',
    ...overrides,
  }
}

// ---- classifyLatestRelease: the pure "which source wins" decision logic ----

test('a matched docker-registry snapshot is always classified as external', () => {
  const result = classifyLatestRelease({
    service: 'CMS',
    dockerRepository: 'vknighthub/ips_o24cms',
    dockerHub,
    matchedSnapshot: makeSnapshot({ source: 'docker-registry' }),
    githubRun: null,
    matchingBuildIntent: makeBuildIntent(), // must be ignored — docker-registry is never release-control/github
    discoveredAt: '2026-08-22T01:00:00.000Z',
  })
  assert.equal(result.source, 'external')
  assert.equal(result.repoDigest, dockerHub.repoDigest)
  assert.equal(result.snapshotId, 'release:CMS:digest:' + 'a'.repeat(64))
})

test('a matched github-actions snapshot dispatched by release-control is classified as release-control', () => {
  const snapshot = makeSnapshot({
    source: 'github-actions',
    branch: 'developer',
    commitSha: 'c'.repeat(40),
    githubRunId: 4242,
    githubRunAttempt: 1,
  })
  const result = classifyLatestRelease({
    service: 'CMS',
    dockerRepository: 'vknighthub/ips_o24cms',
    dockerHub,
    matchedSnapshot: snapshot,
    githubRun: null,
    matchingBuildIntent: makeBuildIntent({ runId: 4242 }),
    discoveredAt: '2026-08-22T01:00:00.000Z',
  })
  assert.equal(result.source, 'release-control')
  assert.equal(result.branch, 'developer')
  assert.equal(result.commitSha, 'c'.repeat(40))
  assert.equal(result.workflowRunId, 4242)
})

test('a matched github-actions snapshot with no matching BuildIntent is classified as github, not release-control', () => {
  const snapshot = makeSnapshot({ source: 'github-actions', githubRunId: 4242, githubRunAttempt: 1 })
  const result = classifyLatestRelease({
    service: 'CMS',
    dockerRepository: 'vknighthub/ips_o24cms',
    dockerHub,
    matchedSnapshot: snapshot,
    githubRun: null,
    matchingBuildIntent: makeBuildIntent({ runId: 9999 }), // a different run — not this one
    discoveredAt: '2026-08-22T01:00:00.000Z',
  })
  assert.equal(result.source, 'github')
})

test('no matched snapshot but a github run found dispatched by release-control is classified as release-control (advisory)', () => {
  const run = makeGithubRun({ runId: 555 })
  const result = classifyLatestRelease({
    service: 'CMS',
    dockerRepository: 'vknighthub/ips_o24cms',
    dockerHub,
    matchedSnapshot: null,
    githubRun: run,
    matchingBuildIntent: makeBuildIntent({ runId: 555 }),
    discoveredAt: '2026-08-22T01:00:00.000Z',
  })
  assert.equal(result.source, 'release-control')
  assert.equal(result.workflowRunId, 555)
  assert.equal(result.workflowRunUrl, run.htmlUrl)
  // Advisory branch: createdAt must NOT be borrowed from the run — it isn't
  // proven to be when this exact digest was pushed.
  assert.equal(result.createdAt, undefined)
})

test('no matched snapshot, a github run found but not dispatched by release-control is classified as github', () => {
  const result = classifyLatestRelease({
    service: 'CMS',
    dockerRepository: 'vknighthub/ips_o24cms',
    dockerHub,
    matchedSnapshot: null,
    githubRun: makeGithubRun({ runId: 555 }),
    matchingBuildIntent: null,
    discoveredAt: '2026-08-22T01:00:00.000Z',
  })
  assert.equal(result.source, 'github')
})

test('neither a matched snapshot nor a github run is classified as unknown, with only the digest known', () => {
  const result = classifyLatestRelease({
    service: 'CMS',
    dockerRepository: 'vknighthub/ips_o24cms',
    dockerHub,
    matchedSnapshot: null,
    githubRun: null,
    matchingBuildIntent: null,
    discoveredAt: '2026-08-22T01:00:00.000Z',
  })
  assert.equal(result.source, 'unknown')
  assert.equal(result.repoDigest, dockerHub.repoDigest)
  assert.equal(result.tag, dockerHub.tag)
  assert.equal(result.branch, undefined)
  assert.equal(result.snapshotId, undefined)
})

test('classifyLatestRelease never produces "telegram" — no signal exists in this codebase to justify it', () => {
  const cases = [
    { matchedSnapshot: makeSnapshot({ source: 'docker-registry' }), githubRun: null, matchingBuildIntent: null },
    { matchedSnapshot: makeSnapshot({ source: 'github-actions', githubRunId: 1, githubRunAttempt: 1 }), githubRun: null, matchingBuildIntent: null },
    { matchedSnapshot: null, githubRun: makeGithubRun(), matchingBuildIntent: null },
    { matchedSnapshot: null, githubRun: null, matchingBuildIntent: null },
  ] as const
  for (const testCase of cases) {
    const result = classifyLatestRelease({
      service: 'CMS',
      dockerRepository: 'vknighthub/ips_o24cms',
      dockerHub,
      discoveredAt: '2026-08-22T01:00:00.000Z',
      ...testCase,
    })
    assert.notEqual(result.source, 'telegram')
  }
})

// ---- resolveLatestRelease: the I/O orchestration around the above ----

test('resolveLatestRelease returns null when Docker Hub has nothing, without calling any other lookup', async () => {
  let calledOtherLookups = false
  const result = await resolveLatestRelease('CMS', {
    dockerHub: null,
    getByDigest: async () => {
      calledOtherLookups = true
      return undefined
    },
    findLatestGithubRunForService: async () => {
      calledOtherLookups = true
      return null
    },
  })
  assert.equal(result, null)
  assert.equal(calledOtherLookups, false)
})

test('resolveLatestRelease prefers an exact digest match over the github-run fallback', async () => {
  const snapshot = makeSnapshot({ source: 'docker-registry' })
  let githubScanCalled = false
  const result = await resolveLatestRelease('CMS', {
    dockerHub,
    getByDigest: async () => snapshot,
    findLatestGithubRunForService: async () => {
      githubScanCalled = true
      return makeGithubRun()
    },
  })
  assert.equal(result?.source, 'external')
  assert.equal(result?.snapshotId, snapshot.id)
  assert.equal(githubScanCalled, false)
})

test('resolveLatestRelease falls back to the github-run scan when no snapshot matches the digest', async () => {
  const result = await resolveLatestRelease('CMS', {
    dockerHub,
    getByDigest: async () => undefined,
    findLatestGithubRunForService: async () => makeGithubRun({ runId: 777 }),
    getLatestBuildIntent: async () => makeBuildIntent({ runId: 777 }),
  })
  assert.equal(result?.source, 'release-control')
  assert.equal(result?.workflowRunId, 777)
})

test('resolveLatestRelease resolves to unknown when nothing matches at all', async () => {
  const result = await resolveLatestRelease('CMS', {
    dockerHub,
    getByDigest: async () => undefined,
    findLatestGithubRunForService: async () => null,
  })
  assert.equal(result?.source, 'unknown')
  assert.equal(result?.repoDigest, dockerHub.repoDigest)
})
