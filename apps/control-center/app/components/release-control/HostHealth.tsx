import type { HostMetrics } from '../../../lib/types'

// Thresholds shared with Dashboard.tsx's deploy/promote resource warning
// (resourceWarningMessage below) — badge colors and "should I warn before
// deploying" must always agree on the same numbers. CPU and RAM intentionally
// share one pair of boundaries (the spec gives them identical cutoffs); disk
// gets its own, slightly more lenient pair.
const CPU_RAM_WARN_PERCENT = 70
const CPU_RAM_DANGER_PERCENT = 85
const DISK_WARN_PERCENT = 75
const DISK_DANGER_PERCENT = 90

// The pre-deploy/promote warning fires at the DANGER boundary, not the
// (much more common) WARN boundary — a UAT box sitting at 75% RAM is normal
// background noise, not something that should interrupt every deploy.
const DEPLOY_WARNING_RAM_PERCENT = CPU_RAM_DANGER_PERCENT
const DEPLOY_WARNING_DISK_PERCENT = DISK_DANGER_PERCENT

type Tone = 'ok' | 'warning' | 'danger'

const TONE_TEXT_CLASS: Record<Tone, string> = {
  ok: 'text-emerald-400',
  warning: 'text-amber-400',
  danger: 'text-rose-400',
}

function toneFor(value: number, warnAt: number, dangerAt: number): Tone {
  if (value > dangerAt) return 'danger'
  if (value >= warnAt) return 'warning'
  return 'ok'
}

function formatGB(bytes: number): string {
  return (bytes / (1 << 30)).toFixed(1)
}

function formatRatioGB(usedBytes: number, totalBytes: number): string {
  return `${formatGB(usedBytes)}/${formatGB(totalBytes)} GB`
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--'
  const days = Math.floor(seconds / 86400)
  if (days >= 1) return `${days}d`
  const hours = Math.floor(seconds / 3600)
  if (hours >= 1) return `${hours}h`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m`
}

// "Sustained high load" without keeping any history: a 5-minute average
// already smooths out momentary spikes, so load5 crossing the core count is
// used as the signal instead of load1 (which would false-positive on a
// single busy second) — matches the "cao trong thời gian dài" requirement
// without a time-series store.
type OverallStatus = { tone: Tone; icon: string; label: string }

function overallStatus(metrics: HostMetrics): OverallStatus {
  const cpuPct = metrics.cpu.usagePercent
  const ramPct = metrics.memory.usagePercent
  const diskPct = metrics.disk.usagePercent
  const cores = metrics.cpu.cores || 1
  const sustainedLoad = metrics.cpu.load5 / cores

  const isCritical =
    (cpuPct !== undefined && cpuPct > CPU_RAM_DANGER_PERCENT) ||
    ramPct > CPU_RAM_DANGER_PERCENT ||
    diskPct > DISK_DANGER_PERCENT ||
    sustainedLoad > 1.5
  if (isCritical) return { tone: 'danger', icon: '\u{1F534}', label: 'Server quá tải' }

  const isWarning =
    (cpuPct !== undefined && cpuPct >= CPU_RAM_WARN_PERCENT) ||
    ramPct >= CPU_RAM_WARN_PERCENT ||
    diskPct >= DISK_WARN_PERCENT ||
    sustainedLoad > 1
  if (isWarning) return { tone: 'warning', icon: '⚠', label: 'Tài nguyên cao' }

  return { tone: 'ok', icon: '●', label: 'Server ổn định' }
}

/**
 * Whether the target environment is short enough on resources to warn
 * before a deploy/promote proceeds — never blocks, just surfaces the risk
 * in the confirm dialog. Returns null when nothing crosses the danger
 * threshold (or metrics simply aren't available, which must never itself
 * read as "danger").
 */
export function resourceWarningMessage(environmentCode: string, metrics: HostMetrics | undefined): string | null {
  if (!metrics) return null
  const ramPct = metrics.memory.usagePercent
  const diskPct = metrics.disk.usagePercent
  const ramCritical = ramPct >= DEPLOY_WARNING_RAM_PERCENT
  const diskCritical = diskPct >= DEPLOY_WARNING_DISK_PERCENT
  if (!ramCritical && !diskCritical) return null

  const parts: string[] = []
  if (ramCritical) parts.push(`${ramPct.toFixed(0)}% RAM`)
  if (diskCritical) parts.push(`${diskPct.toFixed(0)}% ổ đĩa`)
  return `${environmentCode} đang sử dụng ${parts.join(' và ')}. Triển khai lúc này có thể gây thiếu tài nguyên.`
}

const CONTAINER_LABEL_CLASS = 'text-slate-400'

export function HostHealth({ metrics }: { metrics?: HostMetrics }) {
  if (!metrics) {
    return <span className="text-xs text-slate-600">Không lấy được thông tin server</span>
  }

  const status = overallStatus(metrics)
  const cpuTone = metrics.cpu.usagePercent !== undefined ? toneFor(metrics.cpu.usagePercent, CPU_RAM_WARN_PERCENT, CPU_RAM_DANGER_PERCENT) : 'ok'
  const ramTone = toneFor(metrics.memory.usagePercent, CPU_RAM_WARN_PERCENT, CPU_RAM_DANGER_PERCENT)
  const diskTone = toneFor(metrics.disk.usagePercent, DISK_WARN_PERCENT, DISK_DANGER_PERCENT)

  return (
    <details className="group relative inline-block">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 text-xs [&::-webkit-details-marker]:hidden">
        <span className={`inline-flex items-center gap-1 font-medium ${TONE_TEXT_CLASS[status.tone]}`}>
          <span aria-hidden>{status.icon}</span>
          {status.label}
        </span>
        <span className={cpuTone === 'ok' ? 'text-slate-500' : TONE_TEXT_CLASS[cpuTone]}>
          CPU {metrics.cpu.usagePercent !== undefined ? `${metrics.cpu.usagePercent.toFixed(0)}%` : '--'}
        </span>
        <span className={ramTone === 'ok' ? 'text-slate-500' : TONE_TEXT_CLASS[ramTone]}>
          RAM {formatRatioGB(metrics.memory.usedBytes, metrics.memory.totalBytes)}
        </span>
        <span className={diskTone === 'ok' ? 'text-slate-500' : TONE_TEXT_CLASS[diskTone]}>
          Disk {formatRatioGB(metrics.disk.usedBytes, metrics.disk.totalBytes)}
        </span>
        <span className="text-slate-500">Load {metrics.cpu.load1.toFixed(2)}</span>
        <span className="text-slate-500">Uptime {formatUptime(metrics.uptimeSeconds)}</span>
      </summary>
      <div className="absolute left-0 z-10 mt-1.5 w-72 rounded-lg border border-slate-800 bg-slate-900 p-3 text-xs shadow-2xl shadow-black/50">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <dt className="text-slate-500">Hostname</dt>
          <dd className="text-right text-slate-300">{metrics.hostname}</dd>
          <dt className="text-slate-500">OS</dt>
          <dd className="text-right text-slate-300">{metrics.os || '--'}</dd>
          <dt className="text-slate-500">Kernel</dt>
          <dd className="text-right text-slate-300">{metrics.kernel || '--'}</dd>
          <dt className="text-slate-500">CPU cores</dt>
          <dd className="text-right text-slate-300">{metrics.cpu.cores}</dd>
          <dt className="text-slate-500">Load 1/5/15m</dt>
          <dd className="text-right text-slate-300">
            {metrics.cpu.load1.toFixed(2)} / {metrics.cpu.load5.toFixed(2)} / {metrics.cpu.load15.toFixed(2)}
          </dd>
          {metrics.swap ? (
            <>
              <dt className="text-slate-500">Swap</dt>
              <dd className="text-right text-slate-300">{formatRatioGB(metrics.swap.usedBytes, metrics.swap.totalBytes)}</dd>
            </>
          ) : null}
          <dt className={CONTAINER_LABEL_CLASS}>Container</dt>
          <dd className="text-right text-slate-300">
            {metrics.containers.running} chạy · {metrics.containers.stopped} dừng · {metrics.containers.restarting} khởi động lại
          </dd>
          {metrics.dockerDiskUsageBytes !== undefined ? (
            <>
              <dt className="text-slate-500">Docker disk</dt>
              <dd className="text-right text-slate-300">{formatGB(metrics.dockerDiskUsageBytes)} GB</dd>
            </>
          ) : null}
        </dl>
        <p className="mt-2 border-t border-slate-800 pt-2 text-slate-600">
          Lấy mẫu lúc {new Date(metrics.sampledAt).toLocaleTimeString('vi-VN')}
        </p>
      </div>
    </details>
  )
}
