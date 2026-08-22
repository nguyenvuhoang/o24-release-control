'use client'

import { useState } from 'react'
import type { AuditRecord } from '../../../lib/types'

const STATUS_DOT: Record<AuditRecord['status'], string> = {
  succeeded: 'bg-emerald-400',
  failed: 'bg-rose-400',
}

const STATUS_LABEL: Record<AuditRecord['status'], string> = {
  succeeded: 'Thành công',
  failed: 'Thất bại',
}

const STATUS_TEXT_COLOR: Record<AuditRecord['status'], string> = {
  succeeded: 'text-emerald-400',
  failed: 'text-rose-400',
}

const ACTION_LABELS: Record<string, string> = {
  deploy: 'TRIỂN KHAI',
  redeploy: 'TRIỂN KHAI LẠI',
  promote: 'CHUYỂN TIẾP',
  restart: 'KHỞI ĐỘNG LẠI',
  rollback: 'QUAY LẠI PHIÊN BẢN',
  import: 'ĐỒNG BỘ DOCKER HUB',
  build: 'BUILD',
}

function actionLabel(action: string): string {
  return ACTION_LABELS[action.toLowerCase()] ?? action.toUpperCase()
}

export type AuditFilter = 'current' | 'all'

type AuditLogPanelProps = {
  records: AuditRecord[]
  activeEnvironmentCode: string
  filter: AuditFilter
  onFilterChange: (filter: AuditFilter) => void
  storageNotConfigured?: boolean
}

const PAGE_SIZE = 10

export function AuditLogPanel({ records, activeEnvironmentCode, filter, onFilterChange, storageNotConfigured }: AuditLogPanelProps) {
  // Resets to the first page whenever the filter itself changes, so
  // switching "Môi trường hiện tại" <-> "Tất cả" never leaves a stale
  // "showing 30 of 12" state from the other filter.
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  const filtered = filter === 'all'
    ? records
    : records.filter((item) =>
        item.environment === activeEnvironmentCode ||
        item.sourceEnvironment === activeEnvironmentCode ||
        item.targetEnvironment === activeEnvironmentCode,
      )
  const visible = filtered.slice(0, visibleCount)
  const hasMore = visibleCount < filtered.length

  function changeFilter(next: AuditFilter) {
    setVisibleCount(PAGE_SIZE)
    onFilterChange(next)
  }

  return (
    <section className="mt-5 w-full rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-200">Lịch sử thao tác</h2>
        <div className="flex items-center gap-2">
          <div className="flex rounded border border-slate-800 p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => changeFilter('current')}
              className={`rounded px-2 py-0.5 transition-colors duration-150 ${
                filter === 'current' ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {activeEnvironmentCode || 'Hiện tại'}
            </button>
            <button
              type="button"
              onClick={() => changeFilter('all')}
              className={`rounded px-2 py-0.5 transition-colors duration-150 ${
                filter === 'all' ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Tất cả
            </button>
          </div>
          <span className="text-[11px] text-slate-600">
            {visible.length}/{filtered.length}
          </span>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded border border-dashed border-slate-800 py-6 text-center">
          {storageNotConfigured ? (
            <>
              <p className="text-sm text-amber-400">Chưa cấu hình kho lưu trữ lịch sử thao tác</p>
              <p className="mt-1 text-xs text-slate-600">
                Đặt KV_REST_API_URL / KV_REST_API_TOKEN (hoặc UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN) để
                bật lưu trữ lâu dài trên Vercel.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-400">Chưa có thao tác triển khai</p>
              <p className="mt-1 text-xs text-slate-600">
                Các thao tác triển khai, khởi động lại hoặc quay phiên bản sẽ hiển thị tại đây.
              </p>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="grid gap-1.5">
            {visible.map((item) => (
              <article
                key={item.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded border border-slate-800/70 px-3 py-2 text-xs"
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[item.status] ?? 'bg-amber-400'}`} />
                <div className="flex min-w-[180px] flex-1 flex-col gap-0.5">
                  <strong className="font-semibold text-slate-100">{actionLabel(item.action)}</strong>
                  <span className="text-slate-400">
                    {item.service ?? '--'} · {item.environment ?? `${item.sourceEnvironment ?? ''} → ${item.targetEnvironment ?? ''}`}
                  </span>
                </div>
                <code title={item.toDigest ?? item.digest} className="hidden truncate text-slate-500 sm:block sm:max-w-[180px]">
                  {shortDigest(item.toDigest ?? item.digest)}
                </code>
                <span className="hidden text-slate-400 sm:block">{item.username}</span>
                <time className="hidden text-slate-400 md:block">{new Date(item.timestamp).toLocaleString('vi-VN')}</time>
                <span className={`shrink-0 font-medium ${STATUS_TEXT_COLOR[item.status] ?? 'text-amber-400'}`}>
                  {STATUS_LABEL[item.status] ?? item.status}
                </span>
              </article>
            ))}
          </div>
          {hasMore ? (
            <div className="mt-2.5 flex justify-center">
              <button
                type="button"
                onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
                className="min-h-[30px] rounded border border-slate-800 bg-slate-900/60 px-3 text-xs font-medium text-slate-200 transition-colors duration-150 hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
              >
                Xem thêm ({filtered.length - visible.length})
              </button>
            </div>
          ) : filtered.length === records.length && records.length >= 30 ? (
            <p className="mt-2 text-center text-[11px] text-slate-600">Chỉ hiển thị {records.length} bản ghi gần nhất.</p>
          ) : null}
        </>
      )}
    </section>
  )
}

function shortDigest(value?: string): string {
  if (!value) return '--'
  return value.length > 22 ? `${value.slice(0, 18)}…${value.slice(-6)}` : value
}
