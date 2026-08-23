'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { BUILD_SERVICES, githubServiceForAgentCode, type BuildServiceCode } from '../../../lib/github/serviceMap'
import { readJsonSafe } from '../../../lib/http'
import { resolveReleaseComparison, toRunningRelease } from '../../../lib/releaseComparison'
import type { EnvironmentDashboard, ReleaseComparison, ReleaseEnvironmentStateResponse, RegistryServiceStatus } from '../../../lib/types'

// 30–60s per the "Latest Build vs DEV vs UAT vs PROD" auto-refresh
// requirement — deliberately its OWN cadence, decoupled from Dashboard's
// faster 15s poll (see the refs below), so this doesn't add a request every
// single dashboard tick. Explicit action-triggered refreshes (after
// build/import/deploy/promote/restart/rollback) call `refresh()` directly
// instead of waiting for this timer.
const REFRESH_INTERVAL_MS = 45_000

type ComparisonMap = Partial<Record<BuildServiceCode, ReleaseComparison>>

/**
 * Builds the "Latest Build vs DEV vs UAT vs PROD" comparison for all 7
 * services, entirely from data the dashboard already fetches — live
 * ServiceStatus per environment (`environments`, from /api/dashboard) and
 * the resolved latest build per service (`registryStatus`, from
 * /api/registry/status) — plus one POST /api/releases/environment-state per
 * service to resolve each environment's running digest to a known
 * ReleaseSnapshot. No new API route, no duplicate agent traffic: this is
 * the single place the comparison state machine (lib/releaseComparison.ts)
 * gets invoked, so no component re-derives it ad hoc.
 */
export function useReleaseComparison(environments: EnvironmentDashboard[], registryStatus: RegistryServiceStatus[]) {
  const [comparisons, setComparisons] = useState<ComparisonMap>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [lastCheckedAt, setLastCheckedAt] = useState<string>()

  // Read via refs inside refresh() so the interval timer always sees the
  // freshest props without needing to restart on every dashboard poll.
  const environmentsRef = useRef(environments)
  const registryStatusRef = useRef(registryStatus)
  environmentsRef.current = environments
  registryStatusRef.current = registryStatus
  const fetchingRef = useRef(false)

  // `overrides` lets a caller that just fetched fresh environments/registry
  // data (e.g. right after a mutation) pass it straight in, instead of this
  // reading environmentsRef/registryStatusRef — which are only updated when
  // THIS hook's owning component re-renders. A caller that does
  // `setState(...)` and, in the same tick, immediately calls refresh() would
  // otherwise race that re-render and read the value from BEFORE the
  // mutation, silently no-op'ing the "refresh after sync/deploy/promote"
  // requirement. The interval timer and the visibility handler below still
  // call refresh() with no args, which is correct for them: by the time they
  // fire, a render has long since happened and the refs are current.
  const refresh = useCallback(async (overrides?: { environments?: EnvironmentDashboard[]; registryStatus?: RegistryServiceStatus[] }) => {
    const envs = overrides?.environments ?? environmentsRef.current
    if (envs.length === 0 || fetchingRef.current) return
    fetchingRef.current = true
    setLoading(true)
    setError(undefined)
    try {
      const registry = overrides?.registryStatus ?? registryStatusRef.current
      const checkedAt = new Date().toISOString()

      const entries = await Promise.all(
        BUILD_SERVICES.map(async (service): Promise<[BuildServiceCode, ReleaseComparison]> => {
          const perEnvironment = envs.map((environment) => ({
            code: environment.code,
            repoDigest: environment.services.find((item) => githubServiceForAgentCode(item.code) === service)?.repoDigest,
          }))

          const matchedByEnvironment = new Map<string, ReleaseEnvironmentStateResponse['items'][number]>()
          try {
            const response = await fetch('/api/releases/environment-state', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ service, environments: perEnvironment }),
            })
            const data = await readJsonSafe<ReleaseEnvironmentStateResponse>(response)
            if (response.ok && data?.items) {
              for (const item of data.items) matchedByEnvironment.set(item.environment, item)
            }
          } catch {
            // Best-effort: comparison still proceeds, just without a
            // matched snapshot for this service this round.
          }

          const runningByCode = new Map(
            envs.map((environment) => {
              const serviceStatus = environment.services.find((item) => githubServiceForAgentCode(item.code) === service)
              const matchedSnapshot = matchedByEnvironment.get(environment.code)?.release
              return [
                environment.code,
                toRunningRelease({
                  environment: environment.code,
                  service,
                  environmentOnline: environment.online,
                  environmentError: environment.error,
                  serviceStatus,
                  matchedSnapshot,
                  checkedAt,
                }),
              ] as const
            }),
          )

          const latest = registry.find((item) => item.service === service)?.latestBuild
          const comparison = resolveReleaseComparison({
            latest,
            dev: runningByCode.get('DEV'),
            uat: runningByCode.get('UAT'),
            prod: runningByCode.get('PROD'),
          })
          return [service, comparison]
        }),
      )

      setComparisons(Object.fromEntries(entries) as ComparisonMap)
      setLastCheckedAt(checkedAt)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không tải được so sánh phiên bản')
    } finally {
      setLoading(false)
      fetchingRef.current = false
    }
  }, [])

  // Own polling loop, paused while the tab isn't visible.
  useEffect(() => {
    let timer: number | undefined
    function stop() {
      if (timer !== undefined) {
        window.clearInterval(timer)
        timer = undefined
      }
    }
    function start() {
      stop()
      if (document.visibilityState === 'visible') {
        timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS)
      }
    }
    function handleVisibility() {
      if (document.visibilityState === 'visible') {
        void refresh()
      }
      start()
    }
    start()
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      stop()
    }
  }, [refresh])

  // Fires the first real fetch as soon as the dashboard actually has
  // environments (its own load is async) — otherwise the initial mount's
  // refresh() would run against an empty list and this would just sit idle
  // until the 45s timer, which is a bad first-paint experience.
  const hasFetchedOnceRef = useRef(false)
  useEffect(() => {
    if (!hasFetchedOnceRef.current && environments.length > 0) {
      hasFetchedOnceRef.current = true
      void refresh()
    }
  }, [environments.length, refresh])

  return { comparisons, loading, error, lastCheckedAt, refresh }
}
