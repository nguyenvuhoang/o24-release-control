import type { EnvironmentDashboard, ServiceStatus } from '../../../lib/types'
import { imageRepositoryFor, githubServiceForAgentCode } from '../../../lib/github/serviceMap'
import { CopyableValue } from './CopyableValue'
import { StatusBadge, buildStatusLabel, buildStatusTone, containerStatusLabel, containerStatusTone, hasHealthCheck, healthLabel, healthTone } from './StatusBadge'
import type { BuildTrackedState } from './useBuildTracker'

type ServiceCardProps = {
  environment: EnvironmentDashboard
  service: ServiceStatus
  nextEnvironment?: EnvironmentDashboard
  previousEnvironment?: EnvironmentDashboard
  previousService?: ServiceStatus
  isBusy: boolean
  buildState?: BuildTrackedState
  onDeploy: (environment: EnvironmentDashboard, service: ServiceStatus) => Promise<void>
  onPromote: (environment: EnvironmentDashboard, service: ServiceStatus) => Promise<void>
  onRestart: (environment: EnvironmentDashboard, service: ServiceStatus) => Promise<void>
  onRollback: (environment: EnvironmentDashboard, service: ServiceStatus) => Promise<void>
  onLogs: (environment: EnvironmentDashboard, service: ServiceStatus) => Promise<void>
  onBuild: (environment: EnvironmentDashboard, service: ServiceStatus) => void
  onViewBuild: (service: ServiceStatus) => void
}

const BUTTON_BASE =
  'flex min-h-[32px] items-center justify-center rounded px-2.5 text-xs font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1'

const BUTTON_VARIANTS = {
  primary: 'bg-emerald-600 text-white hover:bg-emerald-500 focus-visible:outline-emerald-600',
  secondary:
    'border border-slate-800 bg-transparent text-slate-300 hover:border-slate-700 hover:bg-slate-800/60 focus-visible:outline-slate-500',
  danger:
    'border border-rose-900/50 bg-transparent text-rose-400 hover:border-rose-700 hover:bg-rose-500/5 focus-visible:outline-rose-600',
}

export function ServiceCard({
  environment,
  service,
  nextEnvironment,
  previousEnvironment,
  previousService,
  isBusy,
  buildState,
  onDeploy,
  onPromote,
  onRestart,
  onRollback,
  onLogs,
  onBuild,
  onViewBuild,
}: ServiceCardProps) {
  const disabled = isBusy || !environment.online

  // Build only makes sense on the first environment in the chain (source of
  // truth for what gets built), and only for services the GitHub workflow
  // actually knows how to build.
  const githubService = !previousEnvironment ? githubServiceForAgentCode(service.code) : null
  const canBuild = Boolean(githubService)
  const buildBusy = buildState?.status === 'triggering' || buildState?.status === 'queued' || buildState?.status === 'in_progress'

  const buttons: { key: string; label: string; variant: keyof typeof BUTTON_VARIANTS; disabled: boolean; onClick: () => void }[] = []
  if (canBuild) {
    buttons.push({
      key: 'build',
      label: 'Build',
      variant: 'secondary',
      disabled: disabled || buildBusy,
      onClick: () => onBuild(environment, service),
    })
  }
  buttons.push({ key: 'deploy', label: 'Triển khai', variant: 'primary', disabled, onClick: () => void onDeploy(environment, service) })
  if (nextEnvironment) {
    buttons.push({
      key: 'promote',
      label: `Chuyển tiếp → ${nextEnvironment.code}`,
      variant: 'secondary',
      disabled: disabled || !service.digest,
      onClick: () => void onPromote(environment, service),
    })
  }
  buttons.push(
    { key: 'logs', label: 'Nhật ký', variant: 'secondary', disabled, onClick: () => void onLogs(environment, service) },
    { key: 'restart', label: 'Khởi động lại', variant: 'secondary', disabled, onClick: () => void onRestart(environment, service) },
    { key: 'rollback', label: 'Quay lại phiên bản', variant: 'danger', disabled, onClick: () => void onRollback(environment, service) },
  )
  const lastButtonSpansFull = buttons.length % 2 === 1
  const tracked = hasHealthCheck(service.health)

  return (
    <section className="flex w-full min-w-0 flex-col rounded-lg border border-slate-800 bg-slate-900/50 p-3.5 transition-colors duration-150 hover:border-slate-700">
      <div className="mb-2.5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-slate-100">{service.displayName || service.code}</h3>
          <code className="text-[11px] text-slate-600">{service.code}</code>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <StatusBadge tone={containerStatusTone(service.status)} label={containerStatusLabel(service.status)} />
          {tracked ? (
            <StatusBadge tone={healthTone(service.health)} label={healthLabel(service.health)} />
          ) : (
            <span className="text-[10px] text-slate-600" title="Chưa cấu hình health check">
              chưa cấu hình health check
            </span>
          )}
        </div>
      </div>

      <div className="mb-2.5 min-w-0">
        <dt className="mb-0.5 text-[10px] tracking-wide text-slate-500 uppercase">Image</dt>
        <dd className="m-0">
          <CopyableValue value={service.image} className="text-xs" />
        </dd>
      </div>

      <dl className="mb-2.5 grid grid-cols-2 gap-x-3 gap-y-2.5">
        <div className="min-w-0">
          <dt className="mb-0.5 text-[10px] tracking-wide text-slate-500 uppercase">Digest</dt>
          <dd className="m-0">
            <CopyableValue value={service.digest} className="text-xs" />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="mb-0.5 text-[10px] tracking-wide text-slate-500 uppercase">Git Revision</dt>
          <dd className="m-0 truncate text-xs text-slate-400">
            {service.gitRevision ? service.gitRevision.slice(0, 12) : '--'}
          </dd>
        </div>
        <div className="col-span-2 min-w-0">
          <dt className="mb-0.5 text-[10px] tracking-wide text-slate-500 uppercase">Khởi động lúc</dt>
          <dd className="m-0 truncate text-xs text-slate-400">{formatDate(service.startedAt)}</dd>
        </div>
      </dl>

      {canBuild && buildState ? (
        <div className="mb-2.5 rounded border border-slate-800/70 bg-slate-950/30 px-2.5 py-2 text-[11px] leading-relaxed">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <StatusBadge tone={buildStatusTone(buildState.status)} label={buildStatusLabel(buildState.status)} />
            {buildState.runId ? <span className="text-slate-600">Run #{buildState.runId}</span> : null}
          </div>
          {buildState.status === 'success' && githubService ? (
            <div className="mb-1.5 min-w-0">
              <p className="mb-0.5 text-slate-500 uppercase">Latest build</p>
              <p className="m-0 truncate font-mono text-slate-400">
                {imageRepositoryFor(githubService)}:{buildState.tag}
              </p>
            </div>
          ) : null}
          {buildState.status === 'failed' && buildState.error ? (
            <p className="mb-1.5 break-words text-rose-300">{buildState.error}</p>
          ) : null}
          <div className="flex gap-3">
            {buildState.runId ? (
              <button type="button" onClick={() => onViewBuild(service)} className="font-medium text-emerald-400 hover:underline">
                {buildState.status === 'failed' ? 'Xem lỗi' : 'Xem chi tiết build'}
              </button>
            ) : null}
            {buildState.status === 'success' || buildState.status === 'failed' ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onBuild(environment, service)}
                className="font-medium text-slate-400 hover:underline disabled:cursor-not-allowed disabled:opacity-40"
              >
                Build lại
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {previousEnvironment ? (
        <div className="mb-2.5 rounded border border-slate-800/70 bg-slate-950/30 px-2.5 py-2 text-[11px] leading-relaxed">
          {service.digest && previousService?.digest && service.digest === previousService.digest ? (
            <span className="text-emerald-400">✓ Đồng bộ với {previousEnvironment.code}</span>
          ) : (
            <div className="space-y-1">
              <div className="flex gap-1.5">
                <span className="shrink-0 text-slate-600">{previousEnvironment.code}:</span>
                <span className="min-w-0 truncate font-mono text-slate-400">{shortDigest(previousService?.digest)}</span>
              </div>
              <div className="flex gap-1.5">
                <span className="shrink-0 text-slate-600">{environment.code}:</span>
                <span className="min-w-0 truncate font-mono text-slate-400">{shortDigest(service.digest)}</span>
              </div>
              <span className="inline-block rounded bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-400">
                Khác {previousEnvironment.code}
              </span>
            </div>
          )}
        </div>
      ) : null}

      {service.error ? <div className="mb-2.5 text-xs break-words text-rose-400">{service.error}</div> : null}

      <div className="mt-auto grid grid-cols-2 gap-1.5">
        {buttons.map((button, index) => (
          <button
            key={button.key}
            type="button"
            disabled={button.disabled}
            onClick={button.onClick}
            className={`${BUTTON_BASE} ${BUTTON_VARIANTS[button.variant]} ${
              lastButtonSpansFull && index === buttons.length - 1 ? 'col-span-2' : ''
            }`}
          >
            {button.label}
          </button>
        ))}
      </div>
    </section>
  )
}

function formatDate(value?: string): string {
  if (!value || value.startsWith('0001-')) return '--'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '--' : date.toLocaleString('vi-VN')
}

function shortDigest(value?: string): string {
  if (!value) return '--'
  return value.length > 22 ? `${value.slice(0, 18)}…${value.slice(-6)}` : value
}
