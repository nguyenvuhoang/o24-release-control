'use client'

import { useState } from 'react'
import type { BuildServiceCode } from '../../../lib/github/serviceMap'
import { CopyableValue } from './CopyableValue'
import { buildStatusLabel, buildStatusTone, StatusBadge, type BadgeTone } from './StatusBadge'
import type { BuildTrackedState } from './useBuildTracker'
import { useAffectedServicesPreview } from './useAffectedServicesPreview'
import { useBatchBuildRunner, type BatchQueueStatus } from './useBatchBuildRunner'

type AffectedServicesPanelProps = {
  buildBranch: string
  buildBatchConcurrency: number
  triggerBuild: (service: string, opts: { branch: string; tag: string }) => Promise<void>
  getBuildState: (service: string) => BuildTrackedState | undefined
  onClose: () => void
}

const QUEUE_LABELS: Record<BatchQueueStatus, string> = {
  pending: 'ĐANG CHỜ',
  started: 'ĐÃ GỬI',
  skipped: 'ĐÃ BỎ QUA',
}

const QUEUE_TONES: Record<BatchQueueStatus, BadgeTone> = {
  pending: 'neutral',
  started: 'neutral',
  skipped: 'warning',
}

function ServiceRowBadge({ service, queueStatus, getBuildState }: { service: BuildServiceCode; queueStatus: BatchQueueStatus | undefined; getBuildState: (s: string) => BuildTrackedState | undefined }) {
  if (queueStatus === 'started') {
    const build = getBuildState(service)
    if (build) return <StatusBadge tone={buildStatusTone(build.status)} label={buildStatusLabel(build.status)} />
  }
  if (queueStatus) return <StatusBadge tone={QUEUE_TONES[queueStatus]} label={QUEUE_LABELS[queueStatus]} />
  return null
}

export function AffectedServicesPanel({ buildBranch, buildBatchConcurrency, triggerBuild, getBuildState, onClose }: AffectedServicesPanelProps) {
  const [base, setBase] = useState('')
  const [head, setHead] = useState(buildBranch)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const { state, runPreview, toggleService, BUILD_SERVICES } = useAffectedServicesPreview()
  const { state: batchState, runBatch, cancelBatch } = useBatchBuildRunner({ triggerBuild, concurrency: buildBatchConcurrency })

  const canCheck = base.trim().length > 0 && head.trim().length > 0 && !state.loading
  const selectedServices = [...state.selected]
  const canBuild = selectedServices.length > 0 && !batchState.running

  async function handleCheck() {
    await runPreview(base.trim(), head.trim())
  }

  async function handleConfirmBuild() {
    setConfirmOpen(false)
    await runBatch(selectedServices, head.trim() || buildBranch, 'latest')
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/60" role="dialog" aria-modal="true">
      <div className="flex h-full w-full max-w-2xl flex-col overflow-y-auto border-l border-slate-800 bg-slate-950 p-5 shadow-2xl shadow-black/50">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="mb-0.5 text-[11px] tracking-wide text-slate-500">GITHUB COMPARE — W4S</p>
            <h2 className="text-base font-semibold text-slate-100">Kiểm tra service bị ảnh hưởng</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng"
            className="rounded border border-slate-800 px-2.5 py-1.5 text-sm text-slate-400 transition-colors duration-150 hover:bg-slate-900 hover:text-slate-200"
          >
            Đóng
          </button>
        </div>

        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="affected-base" className="mb-1 block text-[11px] tracking-wide text-slate-500 uppercase">
              Base (branch hoặc SHA)
            </label>
            <input
              id="affected-base"
              type="text"
              value={base}
              onChange={(e) => setBase(e.target.value)}
              placeholder="ví dụ: main hoặc SHA commit đã build DEV"
              className="w-full rounded border border-slate-800 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 outline-none focus-visible:border-emerald-600"
            />
          </div>
          <div>
            <label htmlFor="affected-head" className="mb-1 block text-[11px] tracking-wide text-slate-500 uppercase">
              Head (branch hoặc SHA)
            </label>
            <input
              id="affected-head"
              type="text"
              value={head}
              onChange={(e) => setHead(e.target.value)}
              className="w-full rounded border border-slate-800 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 outline-none focus-visible:border-emerald-600"
            />
          </div>
        </div>

        <button
          type="button"
          disabled={!canCheck}
          onClick={() => void handleCheck()}
          className="mb-5 min-h-[34px] self-start rounded bg-emerald-600 px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {state.loading ? 'Đang kiểm tra…' : 'Kiểm tra service bị ảnh hưởng'}
        </button>

        {state.error ? (
          <div className="mb-4 rounded border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-300">{state.error}</div>
        ) : null}

        {state.result ? (
          <div className="flex-1 space-y-4">
            <div className="rounded border border-slate-800 bg-slate-900/40 p-3 text-sm">
              <div className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <p className="text-[11px] tracking-wide text-slate-500 uppercase">Base SHA</p>
                  <CopyableValue value={state.result.compareMeta.baseSha} formatDisplay={(v) => v.slice(0, 12)} />
                </div>
                <div>
                  <p className="text-[11px] tracking-wide text-slate-500 uppercase">Head SHA</p>
                  <CopyableValue value={state.result.compareMeta.headSha} formatDisplay={(v) => v.slice(0, 12)} />
                </div>
              </div>
              <p className="text-slate-400">
                {state.result.compareMeta.totalFiles} file thay đổi · trạng thái compare: <span className="text-slate-200">{state.result.compareMeta.status}</span>
              </p>
            </div>

            {state.result.warnings.length > 0 ? (
              <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-sm text-amber-300">
                <p className="mb-1 font-medium">Cảnh báo — đã fallback build tất cả service để an toàn:</p>
                <ul className="list-inside list-disc space-y-0.5">
                  {state.result.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="space-y-2">
              {BUILD_SERVICES.map((service) => {
                const isAffected = state.result?.affectedServices.includes(service)
                const isSelected = state.selected.has(service)
                const reasons = state.result?.reasons[service] ?? []
                const queueStatus = batchState.queueStatus[service]
                return (
                  <label
                    key={service}
                    className={`flex items-start gap-3 rounded border px-3 py-2.5 transition-colors duration-150 ${
                      isAffected ? 'border-slate-800 bg-slate-900/60' : 'border-slate-800/60 bg-slate-900/20 opacity-70'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={batchState.running}
                      onChange={() => toggleService(service)}
                      className="mt-1"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-sm text-slate-100">{service}</span>
                        <div className="flex items-center gap-2">
                          {!isAffected ? <StatusBadge tone="neutral" label="KHÔNG ẢNH HƯỞNG" /> : null}
                          <ServiceRowBadge service={service} queueStatus={queueStatus} getBuildState={getBuildState} />
                        </div>
                      </div>
                      {reasons.length > 0 ? (
                        <ul className="mt-1 space-y-0.5 text-xs text-slate-400">
                          {reasons.map((reason, i) => (
                            <li key={i}>{reason}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </label>
                )
              })}
            </div>

            <div className="flex items-center gap-2.5 pt-1">
              <button
                type="button"
                disabled={!canBuild}
                onClick={() => setConfirmOpen(true)}
                className="min-h-[34px] rounded bg-emerald-600 px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Build các service bị thay đổi ({selectedServices.length})
              </button>
              {batchState.running ? (
                <button
                  type="button"
                  onClick={cancelBatch}
                  className="min-h-[34px] rounded border border-slate-800 px-4 text-sm font-medium text-slate-300 transition-colors duration-150 hover:bg-slate-800"
                >
                  Huỷ các build đang chờ
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {confirmOpen ? (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-slate-950/75 p-6" role="dialog" aria-modal="true">
          <section className="w-full max-w-md rounded-lg border border-slate-800 bg-slate-950 p-5">
            <p className="mb-0.5 text-[11px] tracking-wide text-slate-500">XÁC NHẬN BUILD HÀNG LOẠT</p>
            <h2 className="mb-3 text-base font-semibold text-slate-100">Build {selectedServices.length} service</h2>
            <ul className="mb-4 space-y-1 font-mono text-sm text-slate-300">
              {selectedServices.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
            <p className="mb-4 text-xs text-slate-500">
              Tối đa {buildBatchConcurrency} service chạy đồng thời. Mỗi service build lỗi sẽ không ảnh hưởng các service khác.
            </p>
            <div className="flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="min-h-[34px] rounded border border-slate-800 bg-transparent px-4 text-sm font-medium text-slate-300 transition-colors duration-150 hover:bg-slate-800"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmBuild()}
                className="min-h-[34px] rounded bg-emerald-600 px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-emerald-500"
              >
                Xác nhận build
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}
