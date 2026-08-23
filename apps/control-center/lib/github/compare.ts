import { readJsonSafe } from '../http'
import { GITHUB_API_BASE, githubConfig } from './client'

// GitHub's compare API caps the `files` array at 300 entries — beyond that
// the array is silently truncated (no explicit "truncated" flag in the
// response), so a comparison with >= 300 files is treated as "not fully
// knowable" by this module. The affected-services resolver must then fall
// back to building every service rather than trusting a partial file list.
const COMPARE_FILES_TRUNCATION_LIMIT = 300

export type CompareFileStatus = 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged'

export type CompareFile = {
  filename: string
  status: CompareFileStatus
  previousFilename?: string
}

export type CompareStatus = 'identical' | 'ahead' | 'behind' | 'diverged'

export type CompareResult = {
  baseSha: string
  headSha: string
  status: CompareStatus
  aheadBy: number
  behindBy: number
  totalCommits: number
  files: CompareFile[]
  /** True when GitHub's 300-file cap likely dropped changed files from `files`. */
  truncated: boolean
}

export class CompareNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CompareNotFoundError'
  }
}

export class CompareRateLimitedError extends Error {
  constructor(
    message: string,
    public readonly resetAt: string | undefined,
  ) {
    super(message)
    this.name = 'CompareRateLimitedError'
  }
}

type GithubCompareFile = {
  filename: string
  status: string
  previous_filename?: string
}

type GithubCompareResponse = {
  status: string
  ahead_by: number
  behind_by: number
  total_commits: number
  base_commit: { sha: string }
  merge_base_commit: { sha: string }
  commits: { sha: string }[]
  files?: GithubCompareFile[]
}

/** Pure classification of GitHub's compare `status` field — kept separate from the fetch so it's unit-testable without mocking network. */
export function classifyCompareStatus(status: string): CompareStatus {
  if (status === 'identical' || status === 'ahead' || status === 'behind' || status === 'diverged') {
    return status
  }
  // GitHub hasn't documented any other value, but never silently misreport
  // an unrecognized status as one of the known ones.
  throw new Error(`Unrecognized GitHub compare status: ${status}`)
}

function normalizeFileStatus(status: string): CompareFileStatus {
  switch (status) {
    case 'added':
    case 'removed':
    case 'modified':
    case 'renamed':
    case 'copied':
    case 'changed':
    case 'unchanged':
      return status
    default:
      // An unrecognized status is still a real changed file — treat it as
      // 'changed' (the safest generic bucket) rather than dropping it.
      return 'changed'
  }
}

/**
 * Compares two refs (branch names or SHAs) in the configured w4s repo.
 * Server-only — never call from client code (token access, see
 * githubConfig). Throws CompareNotFoundError for an unknown ref/commit,
 * CompareRateLimitedError when GitHub's rate limit is exhausted, or a plain
 * Error for any other upstream failure.
 */
export async function compareCommits(base: string, head: string): Promise<CompareResult> {
  const { token, owner, repo, apiVersion } = githubConfig()
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': apiVersion,
    },
    cache: 'no-store',
  })

  if (response.status === 404) {
    throw new CompareNotFoundError(`One or both refs not found: base="${base}" head="${head}"`)
  }
  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get('x-ratelimit-remaining')
    const resetAt = response.headers.get('x-ratelimit-reset') ?? undefined
    if (remaining === '0') {
      throw new CompareRateLimitedError('GitHub API rate limit exceeded', resetAt)
    }
    throw new Error(`GitHub compare forbidden (${response.status})`)
  }

  const data = await readJsonSafe<GithubCompareResponse & { message?: string }>(response)
  if (!response.ok || !data) {
    throw new Error(`GitHub compare failed (${response.status}): ${data?.message ?? response.statusText}`)
  }

  const files = data.files ?? []
  return {
    baseSha: data.base_commit?.sha ?? base,
    headSha: data.commits.at(-1)?.sha ?? head,
    status: classifyCompareStatus(data.status),
    aheadBy: data.ahead_by,
    behindBy: data.behind_by,
    totalCommits: data.total_commits,
    files: files.map((f) => ({
      filename: f.filename,
      status: normalizeFileStatus(f.status),
      previousFilename: f.previous_filename,
    })),
    truncated: files.length >= COMPARE_FILES_TRUNCATION_LIMIT,
  }
}
