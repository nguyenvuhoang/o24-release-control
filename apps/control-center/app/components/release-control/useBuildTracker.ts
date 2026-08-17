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
  error?: string
  updatedAt?: string
}

type BuildRunResult = {
  runId: number
  status: BuildRunStatus
  conclusion: BuildConclusion
  htmlUrl: string
  updatedAt: string
}

type ApiErrorBody = { error?: string; details?: string }

const POLL_INTERVAL_MS = 3000

export function useBuildTracker() {
  const [builds, setBuilds] = useState<Record<string, BuildTrackedState>>({})
  const timers = useRef<Map<string, number>>(new Map())

  const clearTimer = useCallback((service: string) => {
    const timer = timers.current.get(service)
    if (timer !== undefined) {
      window.clearInterval(timer)
      timers.current.delete(service)
    }
  }, [])

  const pollRun = useCallback(
    async (service: string, runId: number) => {
      try {
        const response = await fetch(`/api/builds/${runId}?service=${encodeURIComponent(service)}`, { cache: 'no-store' })
        const data = await readJsonSafe<BuildRunResult & ApiErrorBody>(response)
        if (!response.ok || !data) {
          throw new Error(data?.details ?? data?.error ?? `Không lấy được trạng thái build (mã ${response.status})`)
        }
        setBuilds((prev) => {
          const current = prev[service]
          if (!current || current.runId !== runId) return prev
          const status: BuildTrackedStatus =
            data.status === 'completed' ? (data.conclusion === 'success' ? 'success' : 'failed') : data.status
          return {
            ...prev,
            [service]: { ...current, status, conclusion: data.conclusion, htmlUrl: data.htmlUrl, updatedAt: data.updatedAt },
          }
        })
        if (data.status === 'completed') clearTimer(service)
      } catch (caught) {
        setBuilds((prev) => {
          const current = prev[service]
          if (!current || current.runId !== runId) return prev
          return {
            ...prev,
            [service]: { ...current, status: 'failed', error: caught instanceof Error ? caught.message : 'Không lấy được trạng thái build' },
          }
        })
        clearTimer(service)
      }
    },
    [clearTimer],
  )

  const startPolling = useCallback(
    (service: string, runId: number) => {
      clearTimer(service)
      const timer = window.setInterval(() => void pollRun(service, runId), POLL_INTERVAL_MS)
      timers.current.set(service, timer)
    },
    [clearTimer, pollRun],
  )

  const triggerBuild = useCallback(
    async (service: string, options: { branch: string; tag: string }): Promise<void> => {
      // Double-submit is already prevented by the dialog disabling its
      // submit button while a request is in flight, and by the server-side
      // dispatch lock in /api/builds — no extra client-side guard needed
      // here.
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
        startPolling(service, runId)
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Yêu cầu build thất bại'
        setBuilds((prev) => ({ ...prev, [service]: { status: 'failed', error: message, tag: options.tag, branch: options.branch } }))
        throw caught instanceof Error ? caught : new Error(message)
      }
    },
    [startPolling],
  )

  const getBuildState = useCallback((service: string) => builds[service], [builds])

  useEffect(() => {
    const timersMap = timers.current
    return () => {
      timersMap.forEach((timer) => window.clearInterval(timer))
      timersMap.clear()
    }
  }, [])

  return { builds, getBuildState, triggerBuild }
}
