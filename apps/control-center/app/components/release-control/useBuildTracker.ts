'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { readJsonSafe } from '../../../lib/http'
import type { BuildConclusion, BuildRunStatus } from '../../../lib/types'

// Tracks GitHub Actions build state per GitHub build-service code (e.g.
// "CMS"), independent of any environment or the deploy/restart/rollback
// operation model — a build never touches a running container.
//
// GitHub itself (via /api/builds/latest and /api/builds/{runId}, both
// server-side) is the source of truth for this state, NOT this hook's memory
// and NOT localStorage — a build can originate outside this app entirely
// (Telegram, a direct GitHub-UI dispatch or Re-run, another browser/device),
// so nothing here is trusted until it's been confirmed by a live GitHub
// read. localStorage is used only as an optimistic first-paint cache (see
// PersistedBuild's cached* fields) to avoid a blank flash before that first
// read resolves — every value it seeds is overwritten as soon as the
// corresponding server call returns, whether that's from hydrateFromServer
// on dashboard load, the background poller, or a manual "Đồng bộ trạng thái".
export type BuildTrackedStatus = 'triggering' | 'queued' | 'in_progress' | 'success' | 'failed'

export type BuildTrackedState = {
  status: BuildTrackedStatus
  runId?: number
  runUrl?: string
  htmlUrl?: string
  tag?: string
  branch?: string
  conclusion?: BuildConclusion
  runAttempt?: number
  error?: string
  updatedAt?: string
}

type ApiErrorBody = { error?: string; details?: string }

// Shape shared by GET /api/builds/{runId} and GET /api/builds/latest once a
// run has actually been found — both are "one live GitHub run snapshot".
type RunSnapshotResult = {
  runId: number
  status: BuildRunStatus
  conclusion: BuildConclusion
  htmlUrl: string
  updatedAt: string
  runAttempt?: number
  branch?: string
}

type LatestBuildResult = ({ service: string; runId: null }) | ({ service: string } & RunSnapshotResult)

// null return means "stop polling"; a number is the delay before the next poll.
type PollOutcome = { nextDelayMs: number | null }

const FAST_INTERVAL_MS = 3000
// Once a run completes as a failure, GitHub's "Re-run failed jobs" can land
// minutes later — polling every 3s for that whole time would be wasteful, so
// this cadence (within the requested 15–30s range) is used instead while
// watching for it.
const SLOW_INTERVAL_MS = 20000
// How long to keep slow-watching a completed-failure run for a possible
// re-run before giving up automatically. The manual "Đồng bộ trạng thái"
// action still works after this window closes.
const SLOW_WATCH_WINDOW_MS = 15 * 60 * 1000
const MAX_CONSECUTIVE_ERRORS = 5

function isRunningStatus(status: BuildRunStatus): status is 'queued' | 'in_progress' {
  return status === 'queued' || status === 'in_progress'
}

type BuildUpdate = {
  status: BuildTrackedStatus
  conclusion: BuildConclusion
  nextDelayMs: number | null
  // undefined = clear the slow-watch deadline (not "leave unchanged").
  slowWatchDeadline: number | undefined
}

// Pure decision logic for one live GitHub read, deliberately factored out of
// the hook so the fast/slow/stop/reset state machine — the part a "Re-run
// failed jobs" on GitHub needs to interact with correctly — can be exercised
// directly, without React, fetch, or timers.
export function deriveBuildUpdate(
  data: { status: BuildRunStatus; conclusion: BuildConclusion },
  existingSlowWatchDeadline: number | undefined,
  now: number,
): BuildUpdate {
  if (isRunningStatus(data.status)) {
    // Still running, or GitHub just moved a re-run back into
    // queued/in_progress — go/stay fast. Clearing the deadline here means
    // the NEXT failure (if any) gets its own fresh 15-minute window instead
    // of inheriting a stale one from before this run/attempt.
    return { status: data.status, conclusion: null, nextDelayMs: FAST_INTERVAL_MS, slowWatchDeadline: undefined }
  }

  // status === 'completed'
  if (data.conclusion === 'success') {
    return { status: 'success', conclusion: data.conclusion, nextDelayMs: null, slowWatchDeadline: undefined }
  }

  const deadline = existingSlowWatchDeadline ?? now + SLOW_WATCH_WINDOW_MS
  return {
    status: 'failed',
    conclusion: data.conclusion,
    nextDelayMs: now < deadline ? SLOW_INTERVAL_MS : null,
    slowWatchDeadline: deadline,
  }
}

// Purely an optimistic first-paint cache — see the module doc comment above.
// cached* fields are never treated as fact; only used to seed initial state
// before the first live GitHub read of this session resolves.
type PersistedBuild = {
  runId: number
  tag?: string
  branch?: string
  runUrl?: string
  slowWatchDeadline?: number
  cachedStatus?: BuildTrackedStatus
  cachedConclusion?: BuildConclusion
  cachedRunAttempt?: number
  cachedHtmlUrl?: string
  cachedUpdatedAt?: string
}

const STORAGE_KEY = 'o24-release-control:tracked-builds:v2'

function loadPersistedBuilds(): Record<string, PersistedBuild> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const result: Record<string, PersistedBuild> = {}
    for (const [service, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value && typeof value === 'object' && typeof (value as PersistedBuild).runId === 'number') {
        result[service] = value as PersistedBuild
      }
    }
    return result
  } catch {
    return {}
  }
}

function savePersistedBuilds(entries: Record<string, PersistedBuild>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // Best-effort only — this is a UX cache, not a data store; safe to skip
    // silently if storage is unavailable/full/disabled.
  }
}

function initialBuildsFromCache(): Record<string, BuildTrackedState> {
  const initial: Record<string, BuildTrackedState> = {}
  for (const [service, entry] of Object.entries(loadPersistedBuilds())) {
    if (!entry.cachedStatus) continue
    initial[service] = {
      status: entry.cachedStatus,
      runId: entry.runId,
      runUrl: entry.runUrl,
      tag: entry.tag,
      branch: entry.branch,
      conclusion: entry.cachedConclusion,
      runAttempt: entry.cachedRunAttempt,
      htmlUrl: entry.cachedHtmlUrl,
      updatedAt: entry.cachedUpdatedAt,
    }
  }
  return initial
}

export function useBuildTracker() {
  const [builds, setBuilds] = useState<Record<string, BuildTrackedState>>(initialBuildsFromCache)
  const buildsRef = useRef<Record<string, BuildTrackedState>>({})
  const timers = useRef<Map<string, number>>(new Map())
  const slowWatchDeadline = useRef<Map<string, number>>(new Map())
  const consecutiveErrors = useRef<Map<string, number>>(new Map())
  // Services whose state has been confirmed by an actual GitHub read (or a
  // dispatch response) THIS session — distinct from merely appearing in
  // `builds`, which can also be true from an unverified localStorage-cache
  // seed. hydrateFromServer only skips services already in this set.
  const verifiedThisSession = useRef<Set<string>>(new Set())

  useEffect(() => {
    buildsRef.current = builds
  }, [builds])

  const clearTimer = useCallback((service: string) => {
    const timer = timers.current.get(service)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timers.current.delete(service)
    }
  }, [])

  const persistEntry = useCallback((service: string, patch: Partial<PersistedBuild>) => {
    const all = loadPersistedBuilds()
    all[service] = { ...all[service], ...patch } as PersistedBuild
    savePersistedBuilds(all)
  }, [])

  // Applies one live GitHub run snapshot to state + the optimistic cache,
  // returning how long to wait before the next poll (or null to stop).
  // Shared by the per-runId background poller and the latest-build sync path
  // so both always agree on what "current" means and never disagree on the
  // slow-watch deadline for the same service.
  const applyRunResult = useCallback(
    (service: string, snapshot: RunSnapshotResult): number | null => {
      verifiedThisSession.current.add(service)
      const update = deriveBuildUpdate(snapshot, slowWatchDeadline.current.get(service), Date.now())
      if (update.slowWatchDeadline === undefined) {
        slowWatchDeadline.current.delete(service)
      } else {
        slowWatchDeadline.current.set(service, update.slowWatchDeadline)
      }
      persistEntry(service, {
        runId: snapshot.runId,
        branch: snapshot.branch,
        slowWatchDeadline: update.slowWatchDeadline,
        cachedStatus: update.status,
        cachedConclusion: update.conclusion,
        cachedRunAttempt: snapshot.runAttempt,
        cachedHtmlUrl: snapshot.htmlUrl,
        cachedUpdatedAt: snapshot.updatedAt,
      })

      setBuilds((prev) => {
        const current = prev[service]
        return {
          ...prev,
          [service]: {
            ...current,
            status: update.status,
            conclusion: update.conclusion,
            runId: snapshot.runId,
            runAttempt: snapshot.runAttempt,
            htmlUrl: snapshot.htmlUrl,
            branch: snapshot.branch ?? current?.branch,
            updatedAt: snapshot.updatedAt,
            error: update.status === 'failed' ? current?.error : undefined,
          },
        }
      })

      return update.nextDelayMs
    },
    [persistEntry],
  )

  // Does a single live GitHub read via /api/builds/{runId} — cheap and
  // precise once a runId is already known (the background poll loop and any
  // GitHub "Re-run failed jobs" on that same runId are both handled here,
  // since GitHub's per-run endpoint always reflects the latest attempt).
  const pollRun = useCallback(
    async (service: string, runId: number): Promise<PollOutcome> => {
      try {
        const response = await fetch(`/api/builds/${runId}?service=${encodeURIComponent(service)}`, { cache: 'no-store' })
        const data = await readJsonSafe<RunSnapshotResult & ApiErrorBody>(response)
        if (!response.ok || !data) {
          throw new Error(data?.details ?? data?.error ?? `Không lấy được trạng thái build (mã ${response.status})`)
        }
        consecutiveErrors.current.delete(service)

        // A newer build (or nothing at all) has since taken over this
        // service's tracking slot — this response is for a stale runId.
        if (buildsRef.current[service]?.runId !== runId) {
          return { nextDelayMs: null }
        }

        return { nextDelayMs: applyRunResult(service, data) }
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Không lấy được trạng thái build'
        const errorCount = (consecutiveErrors.current.get(service) ?? 0) + 1
        consecutiveErrors.current.set(service, errorCount)

        if (errorCount >= MAX_CONSECUTIVE_ERRORS) {
          setBuilds((prev) => {
            const current = prev[service]
            if (!current || current.runId !== runId) return prev
            return { ...prev, [service]: { ...current, status: 'failed', error: message } }
          })
          return { nextDelayMs: null }
        }

        // Transient hiccup (network blip, GitHub rate limit, etc.) — don't
        // stomp a possibly-still-good status over it, just retry at the
        // cadence implied by whether we were already slow-watching.
        const deadline = slowWatchDeadline.current.get(service)
        const retryDelay = deadline && Date.now() < deadline ? SLOW_INTERVAL_MS : FAST_INTERVAL_MS
        return { nextDelayMs: retryDelay }
      }
    },
    [applyRunResult],
  )

  // pollRunRef breaks the pollRun <-> runAndSchedule circular dependency: the
  // scheduled setTimeout always calls through the ref, so runAndSchedule
  // never needs pollRun in its own deps.
  const pollRunRef = useRef(pollRun)
  useEffect(() => {
    pollRunRef.current = pollRun
  }, [pollRun])

  const runAndSchedule = useCallback(
    async (service: string, runId: number) => {
      const { nextDelayMs } = await pollRunRef.current(service, runId)
      clearTimer(service)
      if (nextDelayMs !== null) {
        const handle = window.setTimeout(() => void runAndScheduleRef.current(service, runId), nextDelayMs)
        timers.current.set(service, handle)
      }
    },
    [clearTimer],
  )
  const runAndScheduleRef = useRef(runAndSchedule)
  useEffect(() => {
    runAndScheduleRef.current = runAndSchedule
  }, [runAndSchedule])

  // Does a live discovery read via /api/builds/latest — the server queries
  // GitHub Actions directly for the newest run it can identify as belonging
  // to this service (see findLatestGithubRunForService), independent of
  // whether THIS app dispatched it, tracked it before, or has ever seen this
  // browser/device. Used for the initial per-service hydrate and for the
  // manual "Đồng bộ trạng thái" action — both cases where we can't just
  // reuse a remembered runId.
  const syncFromLatest = useCallback(
    async (service: string): Promise<void> => {
      try {
        const response = await fetch(`/api/builds/latest?service=${encodeURIComponent(service)}`, { cache: 'no-store' })
        const data = await readJsonSafe<LatestBuildResult & ApiErrorBody>(response)
        if (!response.ok || !data) return
        verifiedThisSession.current.add(service)
        if (data.runId === null) return // a real "no build found" answer — nothing to schedule

        const nextDelayMs = applyRunResult(service, data)
        clearTimer(service)
        if (nextDelayMs !== null) {
          const handle = window.setTimeout(() => void runAndScheduleRef.current(service, data.runId as number), nextDelayMs)
          timers.current.set(service, handle)
        }
      } catch {
        // Best-effort discovery: leaves this service's card falling back to
        // "no known run yet" (or whatever the optimistic cache showed) —
        // triggering a build or a later manual sync still works normally.
      }
    },
    [applyRunResult, clearTimer],
  )

  // Called once the dashboard knows which services support build (DEV
  // environment services that map to a GitHub build-service code). Fetches
  // each service's latest state from GitHub, skipping any service already
  // confirmed this session (a just-triggered build, or an already-completed
  // hydrate) — safe to call more than once.
  const hydrateFromServer = useCallback(
    (services: string[]) => {
      for (const service of services) {
        if (verifiedThisSession.current.has(service)) continue
        void syncFromLatest(service)
      }
    },
    [syncFromLatest],
  )

  const triggerBuild = useCallback(
    async (service: string, options: { branch: string; tag: string }): Promise<void> => {
      // Double-submit is already prevented by the dialog disabling its
      // submit button while a request is in flight, and by the server-side
      // dispatch lock in /api/builds — no extra client-side guard needed
      // here.
      clearTimer(service)
      slowWatchDeadline.current.delete(service)
      consecutiveErrors.current.delete(service)
      setBuilds((prev) => ({ ...prev, [service]: { status: 'triggering', tag: options.tag, branch: options.branch } }))

      try {
        const response = await fetch('/api/builds', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ service, branch: options.branch, tag: options.tag }),
        })
        const result = await readJsonSafe<{ success?: boolean; runId?: number; runUrl?: string; htmlUrl?: string } & ApiErrorBody>(response)
        if (!response.ok || !result?.success || !result.runId) {
          throw new Error(result?.details ?? result?.error ?? `Yêu cầu build thất bại (mã ${response.status})`)
        }
        const runId = result.runId
        verifiedThisSession.current.add(service)
        setBuilds((prev) => ({
          ...prev,
          [service]: {
            status: 'queued',
            runId,
            runUrl: result.runUrl,
            htmlUrl: result.htmlUrl,
            tag: options.tag,
            branch: options.branch,
          },
        }))
        persistEntry(service, {
          runId,
          runUrl: result.runUrl,
          tag: options.tag,
          branch: options.branch,
          slowWatchDeadline: undefined,
          cachedStatus: 'queued',
          cachedConclusion: undefined,
          cachedRunAttempt: undefined,
          cachedHtmlUrl: result.htmlUrl,
          cachedUpdatedAt: undefined,
        })
        clearTimer(service)
        const handle = window.setTimeout(() => void runAndScheduleRef.current(service, runId), FAST_INTERVAL_MS)
        timers.current.set(service, handle)
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Yêu cầu build thất bại'
        setBuilds((prev) => ({ ...prev, [service]: { status: 'failed', error: message, tag: options.tag, branch: options.branch } }))
        throw caught instanceof Error ? caught : new Error(message)
      }
    },
    [clearTimer, persistEntry],
  )

  // Manual "Đồng bộ trạng thái": always re-discovers this service's latest
  // build straight from GitHub via /api/builds/latest — not a remembered
  // runId, not localStorage — then resumes whatever polling cadence that
  // fresh state implies. This never triggers a new workflow run (no POST to
  // /api/builds).
  const syncBuild = useCallback(
    (service: string) => {
      void syncFromLatest(service)
    },
    [syncFromLatest],
  )

  const getBuildState = useCallback((service: string) => builds[service], [builds])

  useEffect(() => {
    const timersMap = timers.current
    return () => {
      timersMap.forEach((timer) => window.clearTimeout(timer))
      timersMap.clear()
    }
  }, [])

  return { builds, getBuildState, triggerBuild, syncBuild, hydrateFromServer }
}
