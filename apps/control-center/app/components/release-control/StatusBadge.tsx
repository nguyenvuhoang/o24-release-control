import type { ReleaseComparison, ReleaseComparisonState, ResolvedReleaseSource, RunningRelease } from '../../../lib/types'
import type { BuildTrackedStatus } from './useBuildTracker'

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

// Build status is intentionally a distinct badge vocabulary from container
// status above — a build never changes what's running, so it must never be
// confused with (or overwrite) the container's own state.
export function buildStatusTone(status: BuildTrackedStatus): BadgeTone {
  if (status === 'success') return 'success'
  if (status === 'failed') return 'danger'
  return 'warning'
}

const BUILD_STATUS_LABELS: Record<BuildTrackedStatus, string> = {
  triggering: 'ĐANG GỬI YÊU CẦU',
  queued: 'BUILD ĐANG CHỜ',
  in_progress: 'ĐANG BUILD',
  success: 'BUILD THÀNH CÔNG',
  failed: 'BUILD THẤT BẠI',
}

export function buildStatusLabel(status: BuildTrackedStatus): string {
  return BUILD_STATUS_LABELS[status]
}

// ---- Version comparison (Latest Build vs DEV vs UAT vs PROD) ----
// See lib/releaseComparison.ts — this is display vocabulary only, the
// state/status values themselves are decided entirely by that pure module.

export function runningReleaseStatusTone(status: RunningRelease['containerStatus']): BadgeTone {
  if (status === 'running') return 'success'
  if (status === 'stopped') return 'danger'
  return 'neutral' // missing / unknown
}

const RUNNING_RELEASE_STATUS_LABELS: Record<RunningRelease['containerStatus'], string> = {
  running: 'ĐANG CHẠY',
  stopped: 'ĐÃ DỪNG',
  missing: 'CHƯA TRIỂN KHAI',
  unknown: 'KHÔNG THỂ KIỂM TRA',
}

export function runningReleaseStatusLabel(status: RunningRelease['containerStatus']): string {
  return RUNNING_RELEASE_STATUS_LABELS[status]
}

const RESOLVED_RELEASE_SOURCE_LABELS: Record<ResolvedReleaseSource, string> = {
  'release-control': 'Release Control',
  github: 'GitHub Actions',
  telegram: 'Telegram',
  external: 'Build ngoài hệ thống',
  unknown: 'Không xác định',
}

export function resolvedReleaseSourceLabel(source: ResolvedReleaseSource): string {
  return RESOLVED_RELEASE_SOURCE_LABELS[source]
}

export function resolvedReleaseSourceTone(source: ResolvedReleaseSource): BadgeTone {
  if (source === 'release-control') return 'success'
  if (source === 'external') return 'warning'
  if (source === 'unknown') return 'danger'
  return 'neutral' // github / telegram
}

const COMPARISON_STATE_LABELS: Record<ReleaseComparisonState, string> = {
  NEW_BUILD_AVAILABLE: 'Có bản build mới',
  DEV_SYNCED: 'DEV đã đồng bộ',
  DEV_OUTDATED: 'DEV đang dùng bản cũ',
  UAT_SYNCED_WITH_DEV: 'UAT đã đồng bộ với DEV',
  UAT_DIFFERS_FROM_DEV: 'UAT khác DEV',
  UAT_AHEAD_OR_UNKNOWN: 'UAT chưa đồng bộ với DEV',
  PROD_SYNCED_WITH_UAT: 'PROD đã đồng bộ với UAT',
  PROD_DIFFERS_FROM_UAT: 'PROD khác UAT',
  UNTRACKED_BUILD: 'Build ngoài hệ thống, chưa đồng bộ',
  ENVIRONMENT_UNAVAILABLE: 'Không thể kiểm tra',
  NO_BUILD: 'Chưa có dữ liệu',
  UNKNOWN: 'Không xác định',
}

export function comparisonStateLabel(state: ReleaseComparisonState): string {
  return COMPARISON_STATE_LABELS[state]
}

const COMPARISON_STATE_TONES: Record<ReleaseComparisonState, BadgeTone> = {
  NEW_BUILD_AVAILABLE: 'warning',
  DEV_SYNCED: 'success',
  DEV_OUTDATED: 'danger',
  UAT_SYNCED_WITH_DEV: 'success',
  UAT_DIFFERS_FROM_DEV: 'warning',
  UAT_AHEAD_OR_UNKNOWN: 'warning',
  PROD_SYNCED_WITH_UAT: 'success',
  PROD_DIFFERS_FROM_UAT: 'warning',
  UNTRACKED_BUILD: 'warning',
  ENVIRONMENT_UNAVAILABLE: 'neutral',
  NO_BUILD: 'neutral',
  UNKNOWN: 'neutral',
}

export function comparisonStateTone(state: ReleaseComparisonState): BadgeTone {
  return COMPARISON_STATE_TONES[state]
}

/**
 * The ONE headline badge shown prominently on a service card — "nhìn 3 giây
 * biết service nào cần hành động". Wraps comparisonStateLabel/Tone with a
 * `tooltip` for every state that isn't self-explanatory (an uncertain or
 * unreachable state must always say why, never just "Không xác định" with
 * no further explanation). Purely a display concern — never re-derives the
 * state itself, always reads `comparison.state` as computed by
 * lib/releaseComparison.ts.
 */
export function primaryComparisonBadge(comparison: ReleaseComparison): { label: string; tone: BadgeTone; tooltip?: string } {
  const label = comparisonStateLabel(comparison.state)
  const tone = comparisonStateTone(comparison.state)
  switch (comparison.state) {
    case 'NO_BUILD':
      return { label, tone, tooltip: 'Không tìm thấy tag "latest" nào trên Docker Hub cho dịch vụ này.' }
    case 'ENVIRONMENT_UNAVAILABLE':
      return { label, tone, tooltip: comparison.dev?.error ?? 'Không thể kết nối Deploy Agent DEV để kiểm tra trạng thái.' }
    case 'UNTRACKED_BUILD':
      return { label, tone, tooltip: 'Docker Hub có digest mới nhưng chưa có Release Snapshot tương ứng — cần đồng bộ trước khi triển khai.' }
    case 'DEV_OUTDATED':
      return { label, tone, tooltip: 'DEV đang chạy một digest không khớp bất kỳ Release Snapshot nào đã biết.' }
    case 'UAT_AHEAD_OR_UNKNOWN':
      return { label, tone, tooltip: 'UAT đang chạy một digest không khớp bất kỳ Release Snapshot nào đã biết.' }
    case 'UNKNOWN':
      return { label, tone, tooltip: 'Không đủ dữ liệu để xác định trạng thái đồng bộ của dịch vụ này.' }
    default:
      return { label, tone }
  }
}
