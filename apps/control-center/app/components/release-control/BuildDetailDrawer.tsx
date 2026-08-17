'use client'

import { useEffect, useRef, useState } from 'react'
import { readJsonSafe } from '../../../lib/http'
import type { BuildJob, BuildJobsResponse } from '../../../lib/types'
import type { BuildTrackedStatus } from './useBuildTracker'

type BuildDetailDrawerProps = {
  serviceLabel: string
  runId: number
  runAttempt?: number
  htmlUrl?: string
  status: BuildTrackedStatus
  onClose: () => void
}

const STATUS_BADGE: Record<BuildTrackedStatus, { label: string; className: string }> = {
  triggering: { label: 'Đang gửi yêu cầu', className: 'bg-amber-500/10 text-amber-400' },
  queued: { label: 'Đang chờ', className: 'bg-amber-500/10 text-amber-400' },
  in_progress: { label: 'Đang build', className: 'bg-amber-500/10 text-amber-400' },
  success: { label: 'Build thành công', className: 'bg-emerald-500/10 text-emerald-400' },
  failed: { label: 'Build thất bại', className: 'bg-rose-500/10 text-rose-400' },
}

const RUNNING_STATUSES: BuildTrackedStatus[] = ['triggering', 'queued', 'in_progress']

export function BuildDetailDrawer({ serviceLabel, runId, runAttempt, htmlUrl, status, onClose }: BuildDetailDrawerProps) {
  const [jobs, setJobs] = useState<BuildJob[]>([])
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false

    async function fetchJobs() {
      try {
        const response = await fetch(`/api/builds/${runId}/jobs`, { cache: 'no-store' })
        const data = await readJsonSafe<BuildJobsResponse & { details?: string; error?: string }>(response)
        if (cancelled) return
        if (!response.ok || !data) {
          setError(data?.details ?? data?.error ?? `Không tải được các bước build (mã ${response.status})`)
          return
        }
        setJobs(data.jobs)
        setError(undefined)
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'Không tải được các bước build')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void fetchJobs()
    if (RUNNING_STATUSES.includes(status)) {
      timerRef.current = window.setInterval(() => void fetchJobs(), 3000)
    }

    return () => {
      cancelled = true
      if (timerRef.current !== null) window.clearInterval(timerRef.current)
    }
  }, [runId, status])

  const badge = STATUS_BADGE[status]
  const isRunning = RUNNING_STATUSES.includes(status)

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/60" role="dialog" aria-modal="true">
      <section className="flex h-full w-full max-w-lg flex-col border-l border-slate-800 bg-slate-950 shadow-2xl shadow-black/50">
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 px-5 py-4">
          <div className="min-w-0">
            <p className="mb-1 text-[11px] tracking-wide text-slate-500">
              BUILD · RUN #{runId}
              {runAttempt ? ` · ATTEMPT ${runAttempt}` : ''}
            </p>
            <h2 className="truncate text-base font-semibold text-slate-100">{serviceLabel}</h2>
          </div>
          <span className={`inline-flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-[11px] font-semibold ${badge.className}`}>
            {isRunning ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden /> : null}
            {badge.label}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {error ? (
            <div className="mb-3 rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</div>
          ) : null}
          {loading && jobs.length === 0 && !error ? <p className="text-xs text-slate-600">Đang tải các bước build…</p> : null}
          {!loading && jobs.length === 0 && !error ? <p className="text-xs text-slate-600">Chưa có thông tin bước build.</p> : null}
          {jobs.map((job) => (
            <div key={job.id} className="mb-3">
              <p className="mb-1.5 text-xs font-semibold text-slate-300">{job.name}</p>
              <ul className="space-y-1">
                {job.steps.map((step) => (
                  <li key={step.number} className="flex items-center gap-2 text-xs text-slate-400">
                    <span className={stepIconClass(step.status, step.conclusion)}>{stepIcon(step.status, step.conclusion)}</span>
                    <span className="truncate">{step.name}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-800 px-5 py-3">
          {htmlUrl ? (
            <a
              href={htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-[32px] items-center rounded border border-slate-800 bg-transparent px-3 text-xs font-medium text-slate-300 transition-colors duration-150 hover:bg-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
            >
              Xem trên GitHub
            </a>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={onClose}
            className="min-h-[32px] rounded border border-slate-800 bg-transparent px-3 text-xs font-medium text-slate-300 transition-colors duration-150 hover:bg-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
          >
            Đóng
          </button>
        </div>
      </section>
    </div>
  )
}

function stepIcon(status: string, conclusion: string | null | undefined): string {
  if (status !== 'completed') return status === 'in_progress' ? '●' : '○'
  if (conclusion === 'success') return '✓'
  if (conclusion === 'skipped' || conclusion === 'neutral') return '○'
  return '✗'
}

function stepIconClass(status: string, conclusion: string | null | undefined): string {
  if (status !== 'completed') return status === 'in_progress' ? 'text-amber-400' : 'text-slate-600'
  if (conclusion === 'success') return 'text-emerald-400'
  if (conclusion === 'skipped' || conclusion === 'neutral') return 'text-slate-600'
  return 'text-rose-400'
}
