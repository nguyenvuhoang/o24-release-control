export type BadgeTone = 'success' | 'danger' | 'warning' | 'neutral'

const TONE_CLASSES: Record<BadgeTone, string> = {
  success: 'bg-emerald-500/10 text-emerald-400',
  danger: 'bg-rose-500/10 text-rose-400',
  warning: 'bg-amber-500/10 text-amber-400',
  neutral: 'bg-slate-500/10 text-slate-400',
}

export function StatusBadge({ tone, label }: { tone: BadgeTone; label: string }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide whitespace-nowrap ${TONE_CLASSES[tone]}`}
    >
      {label}
    </span>
  )
}

export function environmentTone(online: boolean): BadgeTone {
  return online ? 'success' : 'danger'
}

export function environmentLabel(online: boolean): string {
  return online ? 'TRỰC TUYẾN' : 'MẤT KẾT NỐI'
}

export function containerStatusTone(status: string): BadgeTone {
  const value = status.toLowerCase()
  if (value === 'running') return 'success'
  if (value === 'restarting' || value === 'starting' || value === 'paused' || value === 'created') return 'warning'
  if (value === 'exited' || value === 'stopped' || value === 'dead') return 'danger'
  return 'neutral'
}

const CONTAINER_STATUS_LABELS: Record<string, string> = {
  running: 'ĐANG CHẠY',
  restarting: 'ĐANG KHỞI ĐỘNG LẠI',
  starting: 'ĐANG KHỞI ĐỘNG',
  paused: 'TẠM DỪNG',
  created: 'ĐÃ TẠO',
  exited: 'ĐÃ DỪNG',
  stopped: 'ĐÃ DỪNG',
  dead: 'LỖI TIẾN TRÌNH',
}

export function containerStatusLabel(status: string): string {
  if (!status) return 'KHÔNG XÁC ĐỊNH'
  return CONTAINER_STATUS_LABELS[status.toLowerCase()] ?? status.toUpperCase()
}

export function healthTone(health: string): BadgeTone {
  const value = health.toLowerCase()
  if (value === 'healthy') return 'success'
  if (value === 'unhealthy') return 'danger'
  if (value === 'starting') return 'warning'
  return 'neutral'
}

const HEALTH_LABELS: Record<string, string> = {
  healthy: 'ỔN ĐỊNH',
  unhealthy: 'LỖI HEALTH CHECK',
  starting: 'ĐANG KIỂM TRA',
}

export function healthLabel(health: string): string {
  return HEALTH_LABELS[health.toLowerCase()] ?? health.toUpperCase()
}

export function hasHealthCheck(health: string): boolean {
  const value = health.toLowerCase()
  return Boolean(value) && value !== 'none'
}
