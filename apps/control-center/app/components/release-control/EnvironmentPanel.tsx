import type { EnvironmentDashboard, ServiceStatus } from '../../../lib/types'
import { displayEnvironmentName } from './environmentDisplay'
import { ServiceCard } from './ServiceCard'
import { StatusBadge, environmentLabel, environmentTone } from './StatusBadge'

type EnvironmentPanelProps = {
  environment: EnvironmentDashboard
  nextEnvironment?: EnvironmentDashboard
  previousEnvironment?: EnvironmentDashboard
  lastUpdatedAt: string
  busyKey: string
  onDeploy: (environment: EnvironmentDashboard, service: ServiceStatus) => Promise<void>
  onPromote: (environment: EnvironmentDashboard, service: ServiceStatus) => Promise<void>
  onRestart: (environment: EnvironmentDashboard, service: ServiceStatus) => Promise<void>
  onRollback: (environment: EnvironmentDashboard, service: ServiceStatus) => Promise<void>
  onLogs: (environment: EnvironmentDashboard, service: ServiceStatus) => Promise<void>
  onRetry: () => void
}

export function EnvironmentPanel({
  environment,
  nextEnvironment,
  previousEnvironment,
  lastUpdatedAt,
  busyKey,
  onDeploy,
  onPromote,
  onRestart,
  onRollback,
  onLogs,
  onRetry,
}: EnvironmentPanelProps) {
  return (
    <article
      className={`w-full overflow-hidden rounded-lg border bg-slate-900/40 ${
        environment.online ? 'border-slate-800' : 'border-rose-500/25'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-base font-semibold text-slate-100">{displayEnvironmentName(environment.name)}</h2>
          <span className="text-xs text-slate-600">{environment.code}</span>
          {environment.agent ? (
            <span className="hidden text-xs text-slate-500 sm:inline">
              Agent {environment.agent.agentVersion} · Compose {environment.agent.composeVersion ?? '--'} ·{' '}
              {environment.services.length} dịch vụ
            </span>
          ) : null}
        </div>
        <StatusBadge tone={environmentTone(environment.online)} label={environmentLabel(environment.online)} />
      </div>

      {environment.agent ? (
        <div className="border-b border-slate-800 px-4 py-1.5 text-xs text-slate-500 sm:hidden">
          Agent {environment.agent.agentVersion} · Compose {environment.agent.composeVersion ?? '--'} ·{' '}
          {environment.services.length} dịch vụ
        </div>
      ) : null}

      {!environment.online ? (
        <div className="flex flex-col items-center gap-2.5 p-10 text-center">
          <p className="text-sm font-medium text-slate-200">Không thể kết nối Deploy Agent {environment.code}</p>
          {environment.error ? (
            <p className="max-w-md text-xs break-words text-rose-300">{environment.error}</p>
          ) : null}
          <p className="text-xs text-slate-500">Lần cập nhật gần nhất: {lastUpdatedAt}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 min-h-[34px] rounded border border-slate-800 bg-slate-900/60 px-4 text-sm font-medium text-slate-200 transition-colors duration-150 hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
          >
            Thử lại
          </button>
        </div>
      ) : (
        <div className="w-full p-4">
          {environment.services.length > 0 ? (
            <div className="grid w-full grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              {environment.services.map((service) => (
                <ServiceCard
                  key={service.code}
                  environment={environment}
                  service={service}
                  nextEnvironment={nextEnvironment}
                  previousEnvironment={previousEnvironment}
                  previousService={previousEnvironment?.services.find((item) => item.code === service.code)}
                  isBusy={busyKey.includes(`${environment.code}:${service.code}`)}
                  onDeploy={onDeploy}
                  onPromote={onPromote}
                  onRestart={onRestart}
                  onRollback={onRollback}
                  onLogs={onLogs}
                />
              ))}
            </div>
          ) : (
            <div className="rounded border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
              Agent chưa cấu hình dịch vụ.
            </div>
          )}
        </div>
      )}
    </article>
  )
}
