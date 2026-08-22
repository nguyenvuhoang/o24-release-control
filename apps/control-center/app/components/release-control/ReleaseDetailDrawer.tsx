'use client'

import { useEffect, useState } from 'react'
import { readJsonSafe } from '../../../lib/http'
import type { AuditRecord, EnvironmentDashboard, ReleaseEnvironmentState, ReleaseHistoryResponse, ReleaseSnapshot } from '../../../lib/types'
import { CopyableValue } from './CopyableValue'
import { StatusBadge } from './StatusBadge'

const SOURCE_LABEL: Record<ReleaseSnapshot['source'], string> = {
  'github-actions': 'GitHub Actions',
  'docker-registry': 'Docker Registry Sync',
}

const ACTION_LABELS: Record<string, string> = {
  deploy: 'TRIỂN KHAI',
  redeploy: 'TRIỂN KHAI LẠI',
  promote: 'CHUYỂN TIẾP',
  restart: 'KHỞI ĐỘNG LẠI',
  rollback: 'QUAY LẠI PHIÊN BẢN',
  build: 'BUILD',
}

function actionLabel(action: string): string {
  return ACTION_LABELS[action.toLowerCase()] ?? action.toUpperCase()
}

const STATUS_LABEL: Record<AuditRecord['status'], string> = { succeeded: 'Thành công', failed: 'Thất bại' }
const STATUS_CLASS: Record<AuditRecord['status'], string> = { succeeded: 'text-emerald-400', failed: 'text-rose-400' }

type ReleaseDetailDrawerProps = {
  release: ReleaseSnapshot
  environments: EnvironmentDashboard[]
  environmentState: ReleaseEnvironmentState[]
  busy: boolean
  onClose: () => void
  onDeploy: (release: ReleaseSnapshot, environmentCode: string, intent: 'redeploy' | 'rollback') => void
}

export function ReleaseDetailDrawer({ release, environments, environmentState, busy, onClose, onDeploy }: ReleaseDetailDrawerProps) {
  const [history, setHistory] = useState<AuditRecord[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyError, setHistoryError] = useState<string>()
  const [targetEnvironment, setTargetEnvironment] = useState(environments[0]?.code ?? '')

  useEffect(() => {
    let cancelled = false
    async function loadHistory() {
      setHistoryLoading(true)
      setHistoryError(undefined)
      try {
        const response = await fetch(`/api/releases/${encodeURIComponent(release.id)}/history`, { cache: 'no-store' })
        const data = await readJsonSafe<ReleaseHistoryResponse & { error?: string; details?: string }>(response)
        if (cancelled) return
        if (!response.ok || !data) {
          throw new Error(data?.details ?? data?.error ?? `Không tải được lịch sử (mã ${response.status})`)
        }
        setHistory(data.items)
      } catch (caught) {
        if (!cancelled) setHistoryError(caught instanceof Error ? caught.message : 'Không tải được lịch sử triển khai')
      } finally {
        if (!cancelled) setHistoryLoading(false)
      }
    }
    void loadHistory()
    return () => {
      cancelled = true
    }
  }, [release.id])

  const runningEnvironments = environmentState.filter((item) => item.release?.id === release.id).map((item) => item.environment)
  const currentInTarget = environmentState.find((item) => item.environment === targetEnvironment)
  const isAlreadyCurrent = currentInTarget?.release?.id === release.id
  const canOperate = environments.length > 0 && Boolean(targetEnvironment)

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/60" role="dialog" aria-modal="true">
      <section className="flex h-full w-full max-w-xl flex-col border-l border-slate-800 bg-slate-950 shadow-2xl shadow-black/50">
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 px-5 py-4">
          <div className="min-w-0">
            <p className="mb-1 text-[11px] tracking-wide text-slate-500">
              RELEASE · {release.service} · {SOURCE_LABEL[release.source]}
            </p>
            <h2 className="truncate font-mono text-base font-semibold text-slate-100">{release.tag}</h2>
          </div>
          {runningEnvironments.length > 0 ? (
            <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
              {runningEnvironments.map((code) => (
                <StatusBadge key={code} tone="success" label={`ĐANG CHẠY · ${code}`} />
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <dl className="mb-5 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
            <Field label="Nhánh" value={release.branch ?? '--'} />
            <Field label="Người tạo/import" value={release.createdBy} />
            <Field label="Commit SHA" value={<CopyableValue value={release.commitSha} className="text-xs" />} full />
            {release.commitMessage ? <Field label="Commit message" value={release.commitMessage} full /> : null}
            <Field label="Thời điểm build/import" value={formatDate(release.createdAt)} full />
            <Field label="Docker repository" value={<CopyableValue value={release.dockerRepository} className="text-xs" />} full />
            <Field label="Repo digest (immutable)" value={<CopyableValue value={release.repoDigest} className="text-xs" truncate={false} />} full />
          </dl>

          <div className="mb-5 rounded border border-slate-800 bg-slate-900/40 p-3.5">
            <h3 className="mb-2 text-xs font-semibold text-slate-300">Triển khai lại / Quay lại phiên bản này</h3>
            {environments.length === 0 ? (
              <p className="text-xs text-slate-500">Không có môi trường nào khả dụng.</p>
            ) : (
              <>
                <label className="mb-2 block text-[11px] text-slate-500">
                  Môi trường đích
                  <select
                    value={targetEnvironment}
                    onChange={(event) => setTargetEnvironment(event.target.value)}
                    className="mt-1 block w-full rounded border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
                  >
                    {environments.map((environment) => (
                      <option key={environment.code} value={environment.code}>
                        {environment.code}
                      </option>
                    ))}
                  </select>
                </label>
                {currentInTarget?.repoDigest && !currentInTarget.release ? (
                  <p className="mb-2 text-[11px] text-amber-400">
                    {targetEnvironment}: digest đang chạy không khớp bất kỳ Release Snapshot nào đã biết — Không đồng bộ.
                  </p>
                ) : null}
                {isAlreadyCurrent ? (
                  <p className="mb-2 text-[11px] text-slate-500">{targetEnvironment} đang chạy đúng release này.</p>
                ) : currentInTarget?.release ? (
                  <p className="mb-2 text-[11px] text-slate-500">
                    {targetEnvironment} hiện đang chạy <span className="font-mono text-slate-400">{currentInTarget.release.tag}</span> — sẽ bị
                    thay thế.
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={!canOperate || busy}
                    onClick={() => onDeploy(release, targetEnvironment, 'redeploy')}
                    className="min-h-[32px] rounded bg-emerald-600 px-3 text-xs font-medium text-white transition-colors duration-150 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
                  >
                    Triển khai lại
                  </button>
                  <button
                    type="button"
                    disabled={!canOperate || busy || isAlreadyCurrent}
                    title={isAlreadyCurrent ? `${targetEnvironment} đã đang chạy đúng digest này` : undefined}
                    onClick={() => onDeploy(release, targetEnvironment, 'rollback')}
                    className="min-h-[32px] rounded border border-rose-900/50 bg-transparent px-3 text-xs font-medium text-rose-400 transition-colors duration-150 hover:border-rose-700 hover:bg-rose-500/5 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-rose-600"
                  >
                    Quay lại phiên bản này
                  </button>
                </div>
              </>
            )}
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold text-slate-300">Lịch sử triển khai</h3>
            {historyError ? <p className="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{historyError}</p> : null}
            {historyLoading && !historyError ? <p className="text-xs text-slate-600">Đang tải lịch sử…</p> : null}
            {!historyLoading && !historyError && history.length === 0 ? (
              <p className="text-xs text-slate-600">Chưa có thao tác nào liên quan đến release này.</p>
            ) : null}
            <div className="grid gap-2">
              {history.map((entry) => (
                <div key={entry.id} className="rounded border border-slate-800/70 px-3 py-2 text-[11px]">
                  <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <strong className="font-semibold text-slate-200">{actionLabel(entry.action)}</strong>
                    <span className="text-slate-500">
                      {entry.environment ?? `${entry.sourceEnvironment ?? ''} → ${entry.targetEnvironment ?? ''}`}
                    </span>
                    <span className={`ml-auto font-medium ${STATUS_CLASS[entry.status] ?? 'text-amber-400'}`}>
                      {STATUS_LABEL[entry.status] ?? entry.status}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-500">
                    <span>{entry.username}</span>
                    <span>{formatDate(entry.timestamp)}</span>
                    {entry.details && typeof entry.details === 'object' && 'operationId' in entry.details ? (
                      <span className="font-mono">op: {String((entry.details as { operationId?: unknown }).operationId ?? '')}</span>
                    ) : null}
                  </div>
                  {entry.fromDigest || entry.toDigest ? (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-slate-500">
                      <span>{shortDigest(entry.fromDigest)}</span>
                      <span>→</span>
                      <span className="text-slate-300">{shortDigest(entry.toDigest)}</span>
                    </div>
                  ) : null}
                  {entry.status === 'failed' && entry.error ? <p className="mt-1 break-words text-rose-300">{entry.error}</p> : null}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-slate-800 px-5 py-3">
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

function Field({ label, value, full }: { label: string; value: React.ReactNode; full?: boolean }) {
  return (
    <div className={full ? 'col-span-2 min-w-0' : 'min-w-0'}>
      <dt className="mb-0.5 text-[10px] tracking-wide text-slate-500 uppercase">{label}</dt>
      <dd className="m-0 min-w-0 text-slate-200">{value}</dd>
    </div>
  )
}

function shortDigest(value?: string): string {
  if (!value) return '--'
  return value.length > 22 ? `${value.slice(0, 18)}…${value.slice(-6)}` : value
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '--' : date.toLocaleString('vi-VN')
}
