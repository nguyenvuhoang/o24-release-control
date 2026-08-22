'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { BuildServiceCode } from '../../../lib/github/serviceMap'
import { readJsonSafe } from '../../../lib/http'
import type {
  ReleaseEnvironmentState,
  ReleaseSnapshot,
  ReleaseSource,
  ReleaseTimelineResponse,
} from '../../../lib/types'

export type ReleaseTimelineFilters = {
  branch?: string
  source?: ReleaseSource
  since?: string
  until?: string
}

type ApiErrorBody = { error?: string; details?: string }

const PAGE_SIZE = 20

function buildQuery(service: BuildServiceCode, filters: ReleaseTimelineFilters, cursor?: string): string {
  const params = new URLSearchParams({ service, limit: String(PAGE_SIZE) })
  if (filters.branch) params.set('branch', filters.branch)
  if (filters.source) params.set('source', filters.source)
  if (filters.since) params.set('since', filters.since)
  if (filters.until) params.set('until', filters.until)
  if (cursor) params.set('cursor', cursor)
  return params.toString()
}

/**
 * Version Timeline data for one selected service — paginated, newest first
 * (see GET /api/releases). Re-fetches from scratch whenever service or
 * filters change; `reload()` is exposed so a successful redeploy/rollback
 * can refresh the list without a full page reload.
 */
export function useReleaseTimeline(service: BuildServiceCode, filters: ReleaseTimelineFilters) {
  const [items, setItems] = useState<ReleaseSnapshot[]>([])
  const [nextCursor, setNextCursor] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string>()
  // Guards against a slow, now-stale request (e.g. from a service the user
  // already switched away from) overwriting a newer one's result.
  const requestSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++requestSeq.current
    setLoading(true)
    setError(undefined)
    try {
      const response = await fetch(`/api/releases?${buildQuery(service, filters)}`, { cache: 'no-store' })
      const data = await readJsonSafe<ReleaseTimelineResponse & ApiErrorBody>(response)
      if (seq !== requestSeq.current) return
      if (!response.ok || !data) {
        throw new Error(data?.details ?? data?.error ?? `Không tải được dòng thời gian phiên bản (mã ${response.status})`)
      }
      setItems(data.items)
      setNextCursor(data.nextCursor)
    } catch (caught) {
      if (seq !== requestSeq.current) return
      setError(caught instanceof Error ? caught.message : 'Không tải được dòng thời gian phiên bản')
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, filters.branch, filters.source, filters.since, filters.until])

  useEffect(() => {
    void load()
  }, [load])

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const response = await fetch(`/api/releases?${buildQuery(service, filters, nextCursor)}`, { cache: 'no-store' })
      const data = await readJsonSafe<ReleaseTimelineResponse & ApiErrorBody>(response)
      if (!response.ok || !data) {
        throw new Error(data?.details ?? data?.error ?? `Không tải được thêm (mã ${response.status})`)
      }
      setItems((prev) => [...prev, ...data.items])
      setNextCursor(data.nextCursor)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không tải được thêm')
    } finally {
      setLoadingMore(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, filters.branch, filters.source, filters.since, filters.until, nextCursor, loadingMore])

  return { items, nextCursor, loading, loadingMore, error, reload: load, loadMore }
}

/**
 * Resolves which known Release Snapshot (if any) is currently running in
 * each environment, for the running-environment badges — see
 * POST /api/releases/environment-state. `environments` should be the live
 * repoDigest per environment straight from /api/dashboard; passed as a plain
 * array (compared by value below) since Dashboard.tsx recomputes it fresh
 * every render.
 */
export function useReleaseEnvironmentState(
  service: BuildServiceCode,
  environments: { code: string; repoDigest?: string }[],
) {
  const [items, setItems] = useState<ReleaseEnvironmentState[]>([])
  const key = JSON.stringify(environments)

  useEffect(() => {
    if (environments.length === 0) {
      setItems([])
      return
    }
    let cancelled = false
    async function run() {
      try {
        const response = await fetch('/api/releases/environment-state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ service, environments }),
        })
        const data = await readJsonSafe<{ items?: ReleaseEnvironmentState[] }>(response)
        if (!cancelled && response.ok && data?.items) setItems(data.items)
      } catch {
        // Best-effort — running-environment badges just won't show.
      }
    }
    void run()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, key])

  return items
}
