import { readJsonSafe } from '../http'
import type { BuildJob, BuildJobsResponse, BuildRunSnapshot } from '../types'

export const GITHUB_API_BASE = 'https://api.github.com'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

// Exported so other server-only GitHub modules (compare.ts, w4sGraph.ts) can
// reuse the same owner/repo/token/apiVersion resolution instead of
// duplicating requireEnv calls — still never imported by client code.
export function githubConfig() {
  return {
    token: requireEnv('GITHUB_TOKEN'),
    owner: requireEnv('GITHUB_OWNER'),
    repo: requireEnv('GITHUB_REPO'),
    workflow: requireEnv('GITHUB_WORKFLOW'),
    apiVersion: process.env.GITHUB_API_VERSION || '2026-03-10',
  }
}

// The branch the build workflow dispatches against. Exposed separately (with
// a safe default) so API routes can validate an incoming request without
// requiring the full GitHub credential set just to read the configured
// branch name.
export function getConfiguredBuildBranch(): string {
  return process.env.GITHUB_BUILD_BRANCH || 'developer'
}

// How many services the "Build các service bị thay đổi" batch flow dispatches
// concurrently — safe default of 2 (never unbounded-parallel), overridable
// via env for deployments that want a different cap.
export function getConfiguredBuildBatchConcurrency(): number {
  const raw = Number(process.env.BUILD_BATCH_CONCURRENCY)
  return Number.isInteger(raw) && raw > 0 ? raw : 2
}

// Thrown specifically for GitHub's 403 "Resource not accessible by personal
// access token" — the exact, verified signature of a fine-grained PAT
// missing a required permission (Contents: Read-only for repo/tree/compare
// reads, Actions: Read and write for workflow_dispatch). Verified empirically
// (see Chat 06 hardening notes): a dispatch with a deliberately invalid ref
// against a token that HAS Actions:Write returns 422 "No ref found" (passed
// the permission check, failed only on the ref) — 403 only ever appears when
// the permission itself is missing. Callers must never fall back to a
// generic "trigger failed" message for this case.
export class GithubPermissionError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(message)
    this.name = 'GithubPermissionError'
  }
}

// Thrown for a 401 — token is missing/revoked/expired. Distinct from
// GithubPermissionError (403: token is valid but lacks a scope) so callers
// (and diagnostics) never conflate "bad token" with "token missing a grant".
export class GithubAuthError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(message)
    this.name = 'GithubAuthError'
  }
}

// Thrown for GitHub's primary (429) and secondary (403 with rate-limit
// signals) rate limits — never for a genuine permission 403, see
// isSecondaryRateLimitSignal. retryAfterMs is the best available hint from
// Retry-After/X-RateLimit-Reset, null when GitHub sent neither.
export class GithubRateLimitError extends Error {
  constructor(
    public readonly path: string,
    message: string,
    public readonly retryAfterMs: number | null,
  ) {
    super(message)
    this.name = 'GithubRateLimitError'
  }
}

// Thrown for GitHub upstream 500/502/503/504 — transient, safe to retry on
// GET requests (never on the dispatch POST, see triggerWorkflowBuild).
export class GithubServerError extends Error {
  constructor(
    public readonly path: string,
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'GithubServerError'
  }
}

// Thrown when the request itself never got a response — DNS/connection
// reset/timeout (the literal "fetch failed" seen in production logs).
// Retryable on GET, same as GithubServerError.
export class GithubNetworkError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(message)
    this.name = 'GithubNetworkError'
  }
}

// Bounded per-attempt timeout — GitHub's API has no documented SLA, and a
// hung connection on a serverless function must never block indefinitely
// (that's exactly how one slow GitHub response turns into a 2,200-request
// pileup). Overridable per-deployment, always bounded.
const DEFAULT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.GITHUB_REQUEST_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000
})()
const MAX_GET_RETRIES = 2 // up to 3 total attempts
const BASE_RETRY_DELAY_MS = 300
const MAX_RETRY_DELAY_MS = 4_000
// Never block a request waiting out a rate limit longer than this — beyond
// it, fail fast so the caller's own fallback (stale cache, known-run
// fallback, etc.) can take over instead of a function hanging near its
// platform timeout.
const MAX_RATE_LIMIT_WAIT_MS = 5_000

function parseRetryAfterMs(response: Response): number | null {
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  }
  const reset = response.headers.get('x-ratelimit-reset')
  if (reset) {
    const resetAtMs = Number(reset) * 1000
    if (Number.isFinite(resetAtMs)) {
      const delay = resetAtMs - Date.now()
      if (delay > 0) return delay
    }
  }
  return null
}

// GitHub signals BOTH permission failures and secondary/primary rate limits
// with a 403 — the only reliable way to tell them apart is these headers
// (never the message text alone, which GitHub doesn't guarantee the wording
// of). A real permission 403 never carries these.
function isSecondaryRateLimitSignal(response: Response): boolean {
  if (response.headers.get('x-ratelimit-remaining') === '0') return true
  if (response.headers.get('retry-after')) return true
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Single HTTP attempt, no retry — used directly by the dispatch POST (which
// must never be blindly retried, see triggerWorkflowBuild) and wrapped by
// githubRequest (below) for every GET read.
async function githubRequestOnce<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  const { token, apiVersion } = githubConfig()
  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(`${GITHUB_API_BASE}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': apiVersion,
        ...init.headers,
      },
      cache: 'no-store',
      signal: controller.signal,
    })
  } catch (networkError) {
    const isTimeout = networkError instanceof Error && networkError.name === 'AbortError'
    const message = networkError instanceof Error ? networkError.message : 'Unknown network error'
    throw new GithubNetworkError(
      path,
      isTimeout ? `GitHub request timed out after ${DEFAULT_TIMEOUT_MS}ms: ${path}` : `GitHub request failed (${path}): ${message}`,
    )
  } finally {
    clearTimeout(timeoutHandle)
  }

  let parsed: unknown
  try {
    parsed = await readJsonSafe(response)
  } catch (parseError) {
    console.error('[github] invalid JSON response', { status: response.status, path })
    throw new Error(parseError instanceof Error ? parseError.message : 'Invalid response from GitHub')
  }

  if (!response.ok) {
    const message = parsed && typeof parsed === 'object' && 'message' in parsed
      ? String((parsed as { message?: unknown }).message ?? response.statusText)
      : response.statusText

    if (response.status === 401) {
      throw new GithubAuthError(path, `GitHub token không hợp lệ hoặc đã hết hạn cho ${path}: ${message}`)
    }
    if (response.status === 403) {
      if (isSecondaryRateLimitSignal(response)) {
        throw new GithubRateLimitError(path, `GitHub rate limit cho ${path}: ${message}`, parseRetryAfterMs(response))
      }
      throw new GithubPermissionError(path, `GitHub token thiếu quyền cần thiết cho ${path}: ${message}`)
    }
    if (response.status === 429) {
      throw new GithubRateLimitError(path, `GitHub rate limit cho ${path}: ${message}`, parseRetryAfterMs(response))
    }
    if (response.status === 500 || response.status === 502 || response.status === 503 || response.status === 504) {
      throw new GithubServerError(path, response.status, `GitHub API ${response.status}: ${message}`)
    }
    throw new Error(`GitHub API ${response.status}: ${message}`)
  }

  return parsed as T | null
}

/**
 * GET-only wrapper: bounded retry (3 attempts total) with exponential
 * backoff + jitter for transient failures (GithubServerError,
 * GithubNetworkError), and for rate limits specifically, waits out
 * Retry-After/X-RateLimit-Reset only up to MAX_RATE_LIMIT_WAIT_MS — never
 * long enough to risk the caller's own timeout. Auth/permission/validation
 * errors are never retried — retrying a 401/403/4xx cannot change the
 * outcome. Never used for the dispatch POST — see triggerWorkflowBuild.
 */
async function githubRequest<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  let attempt = 0
  for (;;) {
    try {
      return await githubRequestOnce<T>(path, init)
    } catch (error) {
      const isLastAttempt = attempt >= MAX_GET_RETRIES

      if (error instanceof GithubRateLimitError) {
        const waitMs = error.retryAfterMs ?? BASE_RETRY_DELAY_MS * 2 ** attempt
        if (isLastAttempt || waitMs > MAX_RATE_LIMIT_WAIT_MS) throw error
        await sleep(waitMs)
        attempt += 1
        continue
      }

      if (error instanceof GithubServerError || error instanceof GithubNetworkError) {
        if (isLastAttempt) throw error
        const base = Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS)
        const jittered = Math.round(base * (0.5 + Math.random()))
        await sleep(jittered)
        attempt += 1
        continue
      }

      // GithubAuthError, GithubPermissionError, or any other (4xx/validation) — never retried.
      throw error
    }
  }
}

type GithubRunResponse = {
  id: number
  url: string
  status: string
  conclusion: string | null
  html_url: string
  head_branch: string
  head_sha: string
  created_at: string
  updated_at: string
  run_attempt?: number
  // Both fields exist on every run object GitHub returns (list AND get);
  // display_title defaults to the head commit's first line UNLESS the
  // workflow overrides it via `run-name:` — see findLatestGithubRunForService.
  name?: string
  display_title?: string
}

type GithubStep = { name: string; status: string; conclusion: string | null; number: number }
type GithubJob = { id: number; name: string; status: string; conclusion: string | null; steps?: GithubStep[] }

function normalizeRun(run: GithubRunResponse): BuildRunSnapshot {
  return {
    runId: run.id,
    status: run.status as BuildRunSnapshot['status'],
    conclusion: run.conclusion as BuildRunSnapshot['conclusion'],
    htmlUrl: run.html_url,
    branch: run.head_branch,
    commitSha: run.head_sha,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    runAttempt: run.run_attempt,
  }
}

/**
 * Fallback only: older GitHub API behavior returns 204 No Content from
 * workflow_dispatch, with no run id in the response. When that happens we
 * have no choice but to poll the "list workflow runs" endpoint and pick the
 * newest run created at/after the dispatch call. The primary path
 * (API version 2026-03-10, see triggerWorkflowBuild) never needs this.
 *
 * Each poll already retries transient failures internally (githubRequest),
 * but a run that exhausts THAT retry budget on one attempt must not abort
 * the whole wait — swallow it and let the next (of 6) attempts try again;
 * only the final attempt's error (if any) is surfaced.
 */
async function resolveDispatchedRun(branch: string, dispatchedAt: Date): Promise<GithubRunResponse> {
  const { owner, repo, workflow } = githubConfig()
  const attempts = 6
  const delayMs = 1500
  const cutoff = dispatchedAt.getTime() - 5000 // small tolerance for clock skew

  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(delayMs)
    try {
      const data = await githubRequest<{ workflow_runs: GithubRunResponse[] }>(
        `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(branch)}&per_page=5`,
      )
      const match = data?.workflow_runs.find((run) => new Date(run.created_at).getTime() >= cutoff)
      if (match) return match
    } catch (error) {
      lastError = error
      console.error('[github] resolveDispatchedRun attempt failed — will retry', {
        attempt,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Timed out waiting for GitHub to register the triggered workflow run')
}

type DispatchResponseBody = {
  workflow_run_id?: unknown
  run_url?: unknown
  html_url?: unknown
}

export async function triggerWorkflowBuild(input: {
  service: string
  branch: string
  tag: string
}): Promise<{ runId: number; runUrl: string; htmlUrl: string }> {
  const { owner, repo, workflow } = githubConfig()
  const dispatchedAt = new Date()

  // githubRequestOnce — NEVER the retrying githubRequest — a dispatch POST
  // that succeeded upstream but whose response we failed to receive must
  // never be retried blindly (that would create a second, duplicate build).
  const data = await githubRequestOnce<DispatchResponseBody>(
    `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
    {
      method: 'POST',
      body: JSON.stringify({
        ref: input.branch,
        inputs: { service: input.service, tag: input.tag },
      }),
    },
  )

  // Primary path — API version 2026-03-10 returns the created run directly
  // in the dispatch response, so no follow-up lookup is needed.
  if (data && typeof data.workflow_run_id === 'number' && typeof data.run_url === 'string' && typeof data.html_url === 'string') {
    return { runId: data.workflow_run_id, runUrl: data.run_url, htmlUrl: data.html_url }
  }

  // Fallback path — some GitHub API versions still return 204 No Content
  // (or an unexpectedly shaped body) with no run id.
  console.error('[github] workflow dispatch response had no usable run id — falling back to run-list polling', {
    service: input.service,
    branch: input.branch,
  })
  const run = await resolveDispatchedRun(input.branch, dispatchedAt)
  return { runId: run.id, runUrl: run.url, htmlUrl: run.html_url }
}

// GitHub's "get a workflow run" endpoint (unlike the per-attempt variant
// under .../attempts/{n}) always reflects the LATEST attempt's status and
// conclusion — combined with cache: 'no-store' in githubRequest, every call
// here reads GitHub's current state fresh; nothing about a previous
// (e.g. failed) attempt is ever cached or reused.
export async function getWorkflowRun(runId: number): Promise<BuildRunSnapshot> {
  const { owner, repo } = githubConfig()
  const data = await githubRequest<GithubRunResponse>(`/repos/${owner}/${repo}/actions/runs/${runId}`)
  if (!data) throw new Error('GitHub returned an empty response for this workflow run')
  return normalizeRun(data)
}

// GitHub's REST API does not expose workflow_dispatch inputs on a run object
// at all (a long-standing platform limitation — there's no `?inputs=` filter
// on "list workflow runs" either), so there's no server-side way to ask
// GitHub directly for "runs dispatched with service=X". The best available
// signal is the run's display title: it defaults to the head commit's first
// line, but reflects a custom `run-name:` expression if the workflow sets
// one (e.g. `run-name: "${{ inputs.service }} · ${{ inputs.tag }}"`, which
// is exactly the idiomatic pattern for disambiguating multi-service
// dispatches like this one in the GitHub Actions UI). This scan assumes
// build-o24.yml does that; if it doesn't, this returns null and the route
// falls back to buildPointerStore for runs control-center itself dispatched.
let runsListCache: { at: number; runs: GithubRunResponse[] } | null = null
// Bounded (not unbounded, not an eternal cache) but wide enough that
// concurrent per-service polling (several services' /api/builds/latest
// calls landing within the same few seconds) shares one GitHub read instead
// of each re-scanning — was 8s, too tight to meaningfully cut duplicate
// traffic under the dashboard's own polling cadence.
const RUNS_LIST_CACHE_TTL_MS = 15_000
// Single-flight: concurrent cache-miss callers (e.g. hydrating every
// service's card at once on page load) await the SAME in-flight GitHub
// request instead of each issuing their own — this is process-local, same
// scope as the cache itself (see the module doc comment above).
let runsListInFlight: Promise<GithubRunResponse[]> | null = null

async function fetchRunsList(): Promise<GithubRunResponse[]> {
  const { owner, repo, workflow } = githubConfig()
  const data = await githubRequest<{ workflow_runs: GithubRunResponse[] }>(
    `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=100`,
  )
  return data?.workflow_runs ?? []
}

async function listRecentWorkflowRuns(): Promise<GithubRunResponse[]> {
  if (runsListCache && Date.now() - runsListCache.at < RUNS_LIST_CACHE_TTL_MS) {
    return runsListCache.runs
  }
  if (runsListInFlight) return runsListInFlight

  runsListInFlight = (async () => {
    try {
      const runs = await fetchRunsList()
      runsListCache = { at: Date.now(), runs }
      return runs
    } catch (error) {
      // Last-known-good fallback: a transient GitHub failure (after
      // githubRequest's own retries are exhausted) must not throw away a
      // still-useful cache — serve it stale rather than making every poller
      // 502 (see "[latestReleaseResolver] GitHub run scan failed" in
      // production logs). Only throws when there is truly nothing cached.
      if (runsListCache) {
        const ageMs = Date.now() - runsListCache.at
        console.error('[github] workflow run list refresh failed — serving stale cache', {
          staleForMs: ageMs,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
        return runsListCache.runs
      }
      throw error
    } finally {
      runsListInFlight = null
    }
  })()

  return runsListInFlight
}

/** Test-only: clears the process-local runs-list cache/in-flight state between tests. */
export function resetGithubRunsListCacheForTests(): void {
  runsListCache = null
  runsListInFlight = null
}

function runMentionsService(run: GithubRunResponse, service: string): boolean {
  const haystack = `${run.display_title ?? ''} ${run.name ?? ''}`
  return new RegExp(`\\b${service}\\b`, 'i').test(haystack)
}

/**
 * Finds the newest run (across all branches — Telegram or a direct GitHub
 * dispatch might not use the configured build branch) whose title mentions
 * `service`. Runs are returned newest-first by the underlying API, so the
 * first match is the latest. Returns null if nothing matches — callers
 * should NOT treat that as "no build has ever happened", only as "the scan
 * couldn't identify one" (see buildPointerStore for the fallback).
 */
export async function findLatestGithubRunForService(service: string): Promise<BuildRunSnapshot | null> {
  const runs = await listRecentWorkflowRuns()
  const match = runs.find((run) => runMentionsService(run, service))
  return match ? normalizeRun(match) : null
}

type GithubCommitResponse = {
  sha: string
  commit: { message: string }
}

/**
 * Resolves a commit's subject line (first line of its message) by sha —
 * used to populate ReleaseSnapshot.commitMessage after commitSha is already
 * known (a workflow run's head_sha, or a docker-registry image's
 * org.opencontainers.image.revision label). Returns null on ANY failure
 * (commit not found, rate-limited, permission error, network) — callers
 * must treat that as "message unavailable", never retry-block a release
 * snapshot on it, and never fall back to guessing a message.
 */
export async function getCommitMessage(sha: string): Promise<string | null> {
  const { owner, repo } = githubConfig()
  try {
    const data = await githubRequest<GithubCommitResponse>(`/repos/${owner}/${repo}/commits/${sha}`)
    const message = data?.commit?.message?.split('\n')[0]?.trim()
    return message || null
  } catch (error) {
    console.error('[github] failed to resolve commit message', { sha, error: error instanceof Error ? error.message : 'Unknown error' })
    return null
  }
}

export async function getWorkflowRunJobs(runId: number): Promise<BuildJobsResponse> {
  const { owner, repo } = githubConfig()
  const data = await githubRequest<{ jobs: GithubJob[] }>(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs`)
  const jobs: BuildJob[] = (data?.jobs ?? []).map((job) => ({
    id: job.id,
    name: job.name,
    status: job.status as BuildJob['status'],
    conclusion: job.conclusion as BuildJob['conclusion'],
    steps: (job.steps ?? []).map((step) => ({
      name: step.name,
      status: step.status as BuildJob['status'],
      conclusion: step.conclusion as BuildJob['conclusion'],
      number: step.number,
    })),
  }))
  return { runId, jobs }
}
