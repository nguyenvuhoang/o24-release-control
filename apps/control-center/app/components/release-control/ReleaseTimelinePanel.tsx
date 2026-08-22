'use client'

import { useMemo, useState } from 'react'
import { BUILD_SERVICES, githubServiceForAgentCode, type BuildServiceCode } from '../../../lib/github/serviceMap'
import type { EnvironmentDashboard, ReleaseDeployIntent, ReleaseSnapshot, ReleaseSource } from '../../../lib/types'
import { ReleaseDetailDrawer } from './ReleaseDetailDrawer'
import { ReleaseTimelineItem } from './ReleaseTimelineItem'
import { useReleaseEnvironmentState, useReleaseTimeline } from './useReleaseTimeline'

type ReleaseTimelinePanelProps = {
  environments: EnvironmentDashboard[]
  operationBusy: boolean
  onDeploy: (release: ReleaseSnapshot, environmentCode: string, intent: ReleaseDeployIntent) => void
  /** Pre-selects a service when opened from a specific card's "Xem dòng thời gian phiên bản" action. */
  initialService?: BuildServiceCode
  /** Present only when rendered as a drawer (see Dashboard.tsx) — shows a Close button and stops this panel being permanently on the page. */
  onClose?: () => void
}

const SOURCE_OPTIONS: { value: ReleaseSource | ''; label: string }[] = [
  { value: '', label: 'Tất cả nguồn' },
  { value: 'github-actions', label: 'GitHub Actions' },
  { value: 'docker-registry', label: 'Docker Registry Sync' },
]

const SELECT_CLASS =
  'min-h-[30px] rounded border border-slate-800 bg-slate-950 px-2.5 text-xs text-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600'
const INPUT_CLASS =
  'min-h-[30px] w-32 rounded border border-slate-800 bg-slate-950 px-2.5 text-xs text-slate-200 placeholder:text-slate-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600'
const BUTTON_CLASS =
  'min-h-[30px] rounded border border-slate-800 bg-slate-900/60 px-3 text-xs font-medium text-slate-200 transition-colors duration-150 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600'

export function ReleaseTimelinePanel({ environments, operationBusy, onDeploy, initialService, onClose }: ReleaseTimelinePanelProps) {
  const [service, setService] = useState<BuildServiceCode>(initialService ?? BUILD_SERVICES[0])
  const [branchFilter, setBranchFilter] = useState('')
  const [sourceFilter, setSourceFilter] = useState<ReleaseSource | ''>('')
  const [environmentFilter, setEnvironmentFilter] = useState('')
  const [selected, setSelected] = useState<ReleaseSnapshot | null>(null)

  const filters = useMemo(() => ({ branch: branchFilter.trim() || undefined, source: sourceFilter || undefined }), [branchFilter, sourceFilter])
  const { items, loading, loadingMore, error, nextCursor, reload, loadMore } = useReleaseTimeline(service, filters)

  const liveDigests = useMemo(
    () =>
      environments.map((environment) => ({
        code: environment.code,
        repoDigest: environment.services.find((item) => githubServiceForAgentCode(item.code) === service)?.repoDigest,
      })),
    [environments, service],
  )
  const environmentState = useReleaseEnvironmentState(service, liveDigests)

  const visibleItems = environmentFilter
    ? items.filter((item) => environmentState.some((state) => state.environment === environmentFilter && state.release?.id === item.id))
    : items

  function handleDeploy(release: ReleaseSnapshot, environmentCode: string, intent: ReleaseDeployIntent) {
    setSelected(null)
    onDeploy(release, environmentCode, intent)
  }

  return (
    <section className="mt-5 w-full rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-200">Dòng thời gian phiên bản</h2>
        <div className="flex flex-wrap items-center gap-2">
          <select value={service} onChange={(event) => setService(event.target.value as BuildServiceCode)} className={SELECT_CLASS}>
            {BUILD_SERVICES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
          <select value={environmentFilter} onChange={(event) => setEnvironmentFilter(event.target.value)} className={SELECT_CLASS}>
            <option value="">Tất cả môi trường</option>
            {environments.map((environment) => (
              <option key={environment.code} value={environment.code}>
                {environment.code}
              </option>
            ))}
          </select>
          <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as ReleaseSource | '')} className={SELECT_CLASS}>
            {SOURCE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <input
            value={branchFilter}
            onChange={(event) => setBranchFilter(event.target.value)}
            placeholder="Lọc theo nhánh"
            className={INPUT_CLASS}
          />
          <button type="button" onClick={() => void reload()} className={BUTTON_CLASS}>
            Làm mới
          </button>
          {onClose ? (
            <button type="button" onClick={onClose} className={BUTTON_CLASS}>
              Đóng
            </button>
          ) : null}
        </div>
      </div>

      {loading ? <TimelineSkeleton /> : null}

      {!loading && error ? <TimelineError message={error} onRetry={() => void reload()} /> : null}

      {!loading && !error && visibleItems.length === 0 ? (
        <div className="rounded border border-dashed border-slate-800 py-8 text-center">
          <p className="text-sm text-slate-400">Chưa có Release Snapshot nào cho {service}.</p>
          <p className="mt-1 text-xs text-slate-600">Build qua GitHub Actions hoặc Đồng bộ từ Docker Hub sẽ hiển thị tại đây.</p>
        </div>
      ) : null}

      {!loading && !error && visibleItems.length > 0 ? (
        <div className="grid gap-2">
          {visibleItems.map((item) => (
            <ReleaseTimelineItem
              key={item.id}
              release={item}
              runningEnvironments={environmentState.filter((state) => state.release?.id === item.id).map((state) => state.environment)}
              onOpen={setSelected}
            />
          ))}
        </div>
      ) : null}

      {!loading && !error && nextCursor ? (
        <div className="mt-3 flex justify-center">
          <button type="button" disabled={loadingMore} onClick={() => void loadMore()} className={BUTTON_CLASS}>
            {loadingMore ? 'Đang tải…' : 'Tải thêm'}
          </button>
        </div>
      ) : null}

      {selected ? (
        <ReleaseDetailDrawer
          release={selected}
          environments={environments}
          environmentState={environmentState}
          busy={operationBusy}
          onClose={() => setSelected(null)}
          onDeploy={handleDeploy}
        />
      ) : null}
    </section>
  )
}

function TimelineSkeleton() {
  return (
    <div className="grid gap-2" aria-hidden>
      {[0, 1, 2].map((index) => (
        <div key={index} className="h-[84px] animate-pulse rounded border border-slate-800/70 bg-slate-900/40" />
      ))}
    </div>
  )
}

function TimelineError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded border border-rose-500/30 bg-rose-500/10 px-4 py-6 text-center">
      <p className="text-sm text-rose-300">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 min-h-[32px] rounded border border-rose-800/60 bg-transparent px-3.5 text-xs font-medium text-rose-300 transition-colors duration-150 hover:bg-rose-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-rose-600"
      >
        Thử lại
      </button>
    </div>
  )
}
