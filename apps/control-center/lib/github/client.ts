import { readJsonSafe } from '../http'
import type { BuildJob, BuildJobsResponse, BuildRunSnapshot } from '../types'

const GITHUB_API_BASE = 'https://api.github.com'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function githubConfig() {
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

async function githubRequest<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  const { token, apiVersion } = githubConfig()
  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': apiVersion,
      ...init.headers,
    },
    cache: 'no-store',
  })

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
    throw new Error(`GitHub API ${response.status}: ${message}`)
  }

  return parsed as T | null
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Fallback only: older GitHub API behavior returns 204 No Content from
 * workflow_dispatch, with no run id in the response. When that happens we
 * have no choice but to poll the "list workflow runs" endpoint and pick the
 * newest run created at/after the dispatch call. The primary path
 * (API version 2026-03-10, see triggerWorkflowBuild) never needs this.
 */
async function resolveDispatchedRun(branch: string, dispatchedAt: Date): Promise<GithubRunResponse> {
  const { owner, repo, workflow } = githubConfig()
  const attempts = 6
  const delayMs = 1500
  const cutoff = dispatchedAt.getTime() - 5000 // small tolerance for clock skew

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(delayMs)
    const data = await githubRequest<{ workflow_runs: GithubRunResponse[] }>(
      `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(branch)}&per_page=5`,
    )
    const match = data?.workflow_runs.find((run) => new Date(run.created_at).getTime() >= cutoff)
    if (match) return match
  }
  throw new Error('Timed out waiting for GitHub to register the triggered workflow run')
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

  const data = await githubRequest<DispatchResponseBody>(
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
const RUNS_LIST_CACHE_TTL_MS = 8000

async function listRecentWorkflowRuns(): Promise<GithubRunResponse[]> {
  if (runsListCache && Date.now() - runsListCache.at < RUNS_LIST_CACHE_TTL_MS) {
    return runsListCache.runs
  }
  const { owner, repo, workflow } = githubConfig()
  const data = await githubRequest<{ workflow_runs: GithubRunResponse[] }>(
    `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=100`,
  )
  const runs = data?.workflow_runs ?? []
  runsListCache = { at: Date.now(), runs }
  return runs
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
