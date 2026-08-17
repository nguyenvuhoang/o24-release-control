'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { readJsonSafe } from '../../../lib/http'
import type { BuildConclusion, BuildRunStatus } from '../../../lib/types'

// Tracks GitHub Actions build state per GitHub build-service code (e.g.
// "CMS"), independent of any environment or the deploy/restart/rollback
// operation model — a build never touches a running container.
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

type BuildRunResult = {
  runId: number
  status: BuildRunStatus
  conclusion: BuildConclusion
  htmlUrl: string
  updatedAt: string
  runAttempt?: number
}

type ApiErrorBody = { error?: string; details?: string }

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

// Only what's needed to re-query GitHub after a page refresh — deliberately
// NOT status/conclusion, which must always come from a fresh GitHub read,
// never from client memory (including whatever was last written here).
type PersistedBuild = {
  runId: number
  tag?: string
  branch?: string
  runUrl?: string
  slowWatchDeadline?: number
}

const STORAGE_KEY = 'o24-release-control:tracked-builds:v1'

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
    // Best-effort only — persistence just avoids a manual re-sync after a
    // page refresh; safe to skip silently if storage is unavailable/full.
  }
}

export function useBuildTracker() {
  const [builds, setBuilds] = useState<Record<string, BuildTrackedState>>({})
  const buildsRef = useRef<Record<string, BuildTrackedState>>({})
  const timers = useRef<Map<string, number>>(new Map())
  const slowWatchDeadline = useRef<Map<string, number>>(new Map())
  const consecutiveErrors = useRef<Map<string, number>>(new Map())

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

  // Does a single live GitHub read via /api/builds/{runId} and applies it to
  // state, returning how long to wait before the next poll (or null to stop).
  // Used identically by the background polling loop, the mount-time
  // rehydrate, and the manual "Đồng bộ trạng thái" sync — one code path, so
  // all three always agree on what "current" means.
  const pollRun = useCallback(
    async (service: string, runId: number): Promise<PollOutcome> => {
      try {
        const response = await fetch(`/api/builds/${runId}?service=${encodeURIComponent(service)}`, { cache: 'no-store' })
        const data = await readJsonSafe<BuildRunResult & ApiErrorBody>(response)
        if (!response.ok || !data) {
          throw new Error(data?.details ?? data?.error ?? `Không lấy được trạng thái build (mã ${response.status})`)
        }
        consecutiveErrors.current.delete(service)

        // A newer build (or nothing at all) has since taken over this
        // service's tracking slot — this response is for a stale runId.
        // Bail out before touching any shared/persisted state so a slow
        // in-flight poll for an old run can never clobber the new one's
        // slow-watch deadline or storage entry.
        if (buildsRef.current[service]?.runId !== runId) {
          return { nextDelayMs: null }
        }

        const update = deriveBuildUpdate(data, slowWatchDeadline.current.get(service), Date.now())
        if (update.slowWatchDeadline === undefined) {
          slowWatchDeadline.current.delete(service)
        } else {
          slowWatchDeadline.current.set(service, update.slowWatchDeadline)
        }
        persistEntry(service, { slowWatchDeadline: update.slowWatchDeadline })

        setBuilds((prev) => {
          const current = prev[service]
          // A newer build (or nothing at all) has since taken over this
          // service's tracking slot — this response is for a stale runId.
          if (!current || current.runId !== runId) return prev
          return {
            ...prev,
            [service]: {
              ...current,
              status: update.status,
              conclusion: update.conclusion,
              runAttempt: data.runAttempt,
              htmlUrl: data.htmlUrl,
              updatedAt: data.updatedAt,
              error: update.status === 'failed' ? current.error : undefined,
            },
          }
        })

        return { nextDelayMs: update.nextDelayMs }
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
    [persistEntry],
  )

  // pollRunRef breaks the pollRun <-> scheduleNext circular dependency: the
  // scheduled setTimeout always calls through the ref, so scheduleNext never
  // needs pollRun in its own deps.
  const pollRunRef = useRef(pollRun)
  useEffect(() => {
    pollRunRef.current = pollRun
  }, [pollRun])

  const runAndSchedule = useCallback(
    async (service: string, runId: number) => {
      const { nextDelayMs } = await pollRunRef.current(service, runId)
      if (nextDelayMs !== null) {
        clearTimer(service)
        const handle = window.setTimeout(() => void runAndScheduleRef.current(service, runId), nextDelayMs)
        timers.current.set(service, handle)
      } else {
        clearTimer(service)
      }
    },
    [clearTimer],
  )
  const runAndScheduleRef = useRef(runAndSchedule)
  useEffect(() => {
    runAndScheduleRef.current = runAndSchedule
  }, [runAndSchedule])

  // Rehydrate on mount: restore which runs were being tracked, then always
  // re-query GitHub for their CURRENT state — never trust the status/
  // conclusion this session last saw, since a "Re-run failed jobs" on GitHub
  // could have happened while the tab was closed or reloaded.
  useEffect(() => {
    const persisted = loadPersistedBuilds()
    const entries = Object.entries(persisted)
    if (entries.length === 0) return

    setBuilds((prev) => {
      const next = { ...prev }
      for (const [service, entry] of entries) {
        if (next[service]) continue
        next[service] = {
          status: 'in_progress', // placeholder, corrected by the immediate re-query below
          runId: entry.runId,
          runUrl: entry.runUrl,
          tag: entry.tag,
          branch: entry.branch,
        }
      }
      return next
    })

    for (const [service, entry] of entries) {
      if (entry.slowWatchDeadline) slowWatchDeadline.current.set(service, entry.slowWatchDeadline)
      void runAndScheduleRef.current(service, entry.runId)
    }
    // Intentionally mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
        persistEntry(service, { runId, runUrl: result.runUrl, tag: options.tag, branch: options.branch, slowWatchDeadline: undefined })
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

  // Manual "Đồng bộ trạng thái": re-checks a build currently shown as
  // success/failed (e.g. after the user re-ran it directly on GitHub) via
  // the exact same live GitHub read the background poller uses, then resumes
  // whatever polling cadence that fresh state implies — including switching
  // back to fast polling if GitHub now shows it queued/in_progress again.
  // This never triggers a new workflow run (no POST to /api/builds).
  const syncBuild = useCallback((service: string) => {
    const runId = buildsRef.current[service]?.runId
    if (runId !== undefined) void runAndScheduleRef.current(service, runId)
  }, [])

  const getBuildState = useCallback((service: string) => builds[service], [builds])

  useEffect(() => {
    const timersMap = timers.current
    return () => {
      timersMap.forEach((timer) => window.clearTimeout(timer))
      timersMap.clear()
    }
  }, [])

  return { builds, getBuildState, triggerBuild, syncBuild }
}
