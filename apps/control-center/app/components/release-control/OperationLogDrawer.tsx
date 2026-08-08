'use client'

import { useEffect, useRef } from 'react'
import { SwalAlert } from '../../../lib/swalAlert'
import type { OperationAction, OperationLogLine, OperationStatus } from '../../../lib/types'

export type ActiveOperation = {
  operationId: string
  environment: string
  service: string
  serviceLabel: string
  action: OperationAction
  actionLabel: string
}

export type ConnectionState = 'connected' | 'reconnecting' | 'lost'

type OperationLogDrawerProps = {
  operation: ActiveOperation
  logs: OperationLogLine[]
  status: OperationStatus
  error?: string
  connectionState?: ConnectionState
  onClose: () => void
}

const STATUS_BADGE: Record<OperationStatus, { label: string; className: string }> = {
  running: { label: 'Đang chạy', className: 'bg-amber-500/10 text-amber-400' },
  success: { label: 'Thành công', className: 'bg-emerald-500/10 text-emerald-400' },
  failed: { label: 'Thất bại', className: 'bg-rose-500/10 text-rose-400' },
}

export function OperationLogDrawer({ operation, logs, status, error, connectionState = 'connected', onClose }: OperationLogDrawerProps) {
  const logRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  useEffect(() => {
    if (stickToBottomRef.current && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [logs])

  function handleScroll() {
    const el = logRef.current
    if (!el) return
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  async function copyLogs() {
    const text = logs.map((line) => `[${formatTime(line.timestamp)}] ${line.message}`).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      SwalAlert.toast('Đã sao chép log')
    } catch {
      SwalAlert.toast('Không thể sao chép log', 'error')
    }
  }

  const badge = STATUS_BADGE[status]

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/60" role="dialog" aria-modal="true">
      <section className="flex h-full w-full max-w-2xl flex-col border-l border-slate-800 bg-slate-950 shadow-2xl shadow-black/50">
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 px-5 py-4">
          <div className="min-w-0">
            <p className="mb-1 text-[11px] tracking-wide text-slate-500">
              {operation.actionLabel.toUpperCase()} · {operation.environment.toUpperCase()}
            </p>
            <h2 className="truncate text-base font-semibold text-slate-100">{operation.serviceLabel}</h2>
          </div>
          <span className={`inline-flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-[11px] font-semibold ${badge.className}`}>
            {status === 'running' ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden /> : null}
            {badge.label}
          </span>
        </div>

        {status === 'running' && (connectionState === 'reconnecting' || connectionState === 'lost') ? (
          <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-300">
            Mất kết nối luồng nhật ký. Đang kết nối lại...
          </div>
        ) : null}

        <div
          ref={logRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto bg-black/40 px-4 py-3 font-mono text-xs leading-relaxed text-slate-300"
        >
          {logs.length === 0 ? (
            <p className="text-slate-600">
              {connectionState === 'reconnecting' ? 'Đang kết nối lại luồng nhật ký…' : 'Đang chờ log…'}
            </p>
          ) : (
            logs.map((line) => (
              <div key={line.index} className="whitespace-pre-wrap break-words">
                <span className="text-slate-600">[{formatTime(line.timestamp)}]</span> {line.message}
              </div>
            ))
          )}
          {status === 'failed' && error ? (
            <div className="mt-3 rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-300">{error}</div>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-800 px-5 py-3">
          <button
            type="button"
            onClick={() => void copyLogs()}
            disabled={logs.length === 0}
            className="min-h-[32px] rounded border border-slate-800 bg-transparent px-3 text-xs font-medium text-slate-300 transition-colors duration-150 hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
          >
            Sao chép log
          </button>
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

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '--' : date.toLocaleTimeString('vi-VN')
}
