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
  promote: 'CHUYỂN TIẾP',
  restart: 'KHỞI ĐỘNG LẠI',
  rollback: 'QUAY LẠI PHIÊN BẢN',
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
}

export function AuditLogPanel({ records, activeEnvironmentCode, filter, onFilterChange }: AuditLogPanelProps) {
  const filtered = filter === 'all'
    ? records
    : records.filter((item) =>
        item.environment === activeEnvironmentCode ||
        item.sourceEnvironment === activeEnvironmentCode ||
        item.targetEnvironment === activeEnvironmentCode,
      )

  return (
    <section className="mt-5 w-full rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-200">Lịch sử thao tác</h2>
        <div className="flex items-center gap-3">
          <div className="flex rounded border border-slate-800 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => onFilterChange('current')}
              className={`rounded px-2.5 py-1 transition-colors duration-150 ${
                filter === 'current' ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Môi trường hiện tại
            </button>
            <button
              type="button"
              onClick={() => onFilterChange('all')}
              className={`rounded px-2.5 py-1 transition-colors duration-150 ${
                filter === 'all' ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Tất cả
            </button>
          </div>
          <span className="text-xs text-slate-500">{filtered.length} bản ghi gần nhất</span>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded border border-dashed border-slate-800 py-6 text-center">
          <p className="text-sm text-slate-400">Chưa có thao tác triển khai</p>
          <p className="mt-1 text-xs text-slate-600">
            Các thao tác triển khai, khởi động lại hoặc quay phiên bản sẽ hiển thị tại đây.
          </p>
        </div>
      ) : (
        <div className="grid gap-2">
          {filtered.map((item) => (
            <article
              key={item.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded border border-slate-800/70 px-3 py-2 text-xs"
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[item.status] ?? 'bg-amber-400'}`} />
              <div className="flex min-w-[180px] flex-1 flex-col gap-0.5">
                <strong className="font-semibold text-slate-100">{actionLabel(item.action)}</strong>
                <span className="text-slate-400">
                  {item.service ?? '--'} · {item.environment ?? `${item.sourceEnvironment ?? ''} → ${item.targetEnvironment ?? ''}`}
                </span>
              </div>
              <code className="hidden truncate text-slate-500 sm:block sm:max-w-[180px]">{shortDigest(item.digest)}</code>
              <span className="hidden text-slate-400 sm:block">{item.username}</span>
              <time className="hidden text-slate-400 md:block">{new Date(item.timestamp).toLocaleString('vi-VN')}</time>
              <span className={`shrink-0 font-medium ${STATUS_TEXT_COLOR[item.status] ?? 'text-amber-400'}`}>
                {STATUS_LABEL[item.status] ?? item.status}
              </span>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function shortDigest(value?: string): string {
  if (!value) return '--'
  return value.length > 22 ? `${value.slice(0, 18)}…${value.slice(-6)}` : value
}
