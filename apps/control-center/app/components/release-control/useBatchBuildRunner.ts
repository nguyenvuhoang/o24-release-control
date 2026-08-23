'use client'

import { useCallback, useRef, useState } from 'react'
import type { BuildServiceCode } from '../../../lib/github/serviceMap'

// A service's status within the BATCH QUEUE itself — distinct from the
// underlying GitHub build status (queued/in_progress/success/failed),
// which continues to be owned entirely by useBuildTracker once dispatch
// happens. This hook only decides WHEN each selected service gets handed to
// the existing triggerBuild — it never re-implements dispatch, polling, or
// Release Snapshot creation.
export type BatchQueueStatus = 'pending' | 'started' | 'skipped'

export type BatchState = {
  running: boolean
  order: BuildServiceCode[]
  queueStatus: Partial<Record<BuildServiceCode, BatchQueueStatus>>
}

const INITIAL_STATE: BatchState = { running: false, order: [], queueStatus: {} }

/**
 * Marks every service still 'pending' as 'skipped' once the batch is
 * cancelled — pure so the "cancel mid-batch never touches an already-
 * started dispatch" contract is directly testable without async/timers.
 */
export function deriveSkippedOnCancel(
  queueStatus: Partial<Record<BuildServiceCode, BatchQueueStatus>>,
): Partial<Record<BuildServiceCode, BatchQueueStatus>> {
  const next = { ...queueStatus }
  for (const service of Object.keys(next) as BuildServiceCode[]) {
    if (next[service] === 'pending') next[service] = 'skipped'
  }
  return next
}

export function useBatchBuildRunner(options: {
  triggerBuild: (service: string, opts: { branch: string; tag: string }) => Promise<void>
  concurrency: number
}) {
  const [state, setState] = useState<BatchState>(INITIAL_STATE)
  const cancelledRef = useRef(false)
  const optionsRef = useRef(options)
  optionsRef.current = options

  const runBatch = useCallback(async (services: BuildServiceCode[], branch: string, tag: string) => {
    cancelledRef.current = false
    const initialQueueStatus: Partial<Record<BuildServiceCode, BatchQueueStatus>> = {}
    for (const service of services) initialQueueStatus[service] = 'pending'
    setState({ running: true, order: services, queueStatus: initialQueueStatus })

    let nextIndex = 0
    async function worker() {
      while (true) {
        if (cancelledRef.current) {
          setState((prev) => ({ ...prev, queueStatus: deriveSkippedOnCancel(prev.queueStatus) }))
          return
        }
        const myIndex = nextIndex
        if (myIndex >= services.length) return
        nextIndex += 1
        const service = services[myIndex]
        setState((prev) => ({ ...prev, queueStatus: { ...prev.queueStatus, [service]: 'started' } }))
        try {
          // triggerBuild owns its own dispatch-cooldown/error handling
          // (see useBuildTracker) — a rejection here just means dispatch
          // itself failed; the tracker already recorded the failure state
          // for this service, so the batch just moves on to the next one.
          await optionsRef.current.triggerBuild(service, { branch, tag })
        } catch {
          // no-op — see comment above
        }
      }
    }

    const workerCount = Math.max(1, Math.min(options.concurrency, services.length))
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    setState((prev) => ({ ...prev, running: false }))
  }, [options.concurrency])

  const cancelBatch = useCallback(() => {
    cancelledRef.current = true
  }, [])

  const resetBatch = useCallback(() => {
    cancelledRef.current = false
    setState(INITIAL_STATE)
  }, [])

  return { state, runBatch, cancelBatch, resetBatch }
}
