import type { EnvironmentDashboard, RegistryServiceStatus, ServiceStatus } from '../../../lib/types'
import { githubServiceForAgentCode } from '../../../lib/github/serviceMap'
import { displayEnvironmentName } from './environmentDisplay'
import { ServiceCard } from './ServiceCard'
import { StatusBadge, environmentLabel, environmentTone } from './StatusBadge'
import type { BuildTrackedState } from './useBuildTracker'

type EnvironmentPanelProps = {
  environment: EnvironmentDashboard
  nextEnvironment?: EnvironmentDashboard
  previousEnvironment?: EnvironmentDashboard
  lastUpdatedAt: string
  busyKey: string
  getBuildState: (service: ServiceStatus) => BuildTrackedState | undefined
  registryStatus: RegistryServiceStatus[]
  registrySyncingKeys: Set<string>
  onDeploy: (environment: EnvironmentDashboard, service: ServiceStatus, prefillDigest?: string) => Promise<void>
  onPromote: (environment: EnvironmentDashboard, service: ServiceStatus) => Promise<void>
  onRestart: (environment: EnvironmentDashboard, service: ServiceStatus) => Promise<void>
  onRollback: (environment: EnvironmentDashboard, service: ServiceStatus) => Promise<void>
  onLogs: (environment: EnvironmentDashboard, service: ServiceStatus) => Promise<void>
  onBuild: (environment: EnvironmentDashboard, service: ServiceStatus) => void
  onViewBuild: (service: ServiceStatus) => void
  onSyncBuild: (service: ServiceStatus) => void
  onSyncRegistry: (service: ServiceStatus) => Promise<void>
  onRetry: () => void
}

export function EnvironmentPanel({
  environment,
  nextEnvironment,
  previousEnvironment,
  lastUpdatedAt,
  busyKey,
  getBuildState,
  registryStatus,
  registrySyncingKeys,
  onDeploy,
  onPromote,
  onRestart,
  onRollback,
  onLogs,
  onBuild,
  onViewBuild,
  onSyncBuild,
  onSyncRegistry,
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
            // auto-fit/minmax instead of fixed breakpoint column counts: each
            // card keeps a guaranteed minimum width so its 2-column action
            // grid never gets so narrow that a label like "Chuyển tiếp → UAT"
            // has to wrap — the number of columns adapts to available width
            // instead of being hard-coded per viewport size.
            <div className="grid w-full grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] gap-4">
              {environment.services.map((service) => {
                const githubService = githubServiceForAgentCode(service.code)
                return (
                  <ServiceCard
                    key={service.code}
                    environment={environment}
                    service={service}
                    nextEnvironment={nextEnvironment}
                    previousEnvironment={previousEnvironment}
                    previousService={previousEnvironment?.services.find((item) => item.code === service.code)}
                    nextService={nextEnvironment?.services.find((item) => item.code === service.code)}
                    registryStatus={githubService ? registryStatus.find((item) => item.service === githubService) : undefined}
                    registrySyncing={githubService ? registrySyncingKeys.has(githubService) : false}
                    isBusy={busyKey.includes(`${environment.code}:${service.code}`)}
                    buildState={getBuildState(service)}
                    onDeploy={onDeploy}
                    onPromote={onPromote}
                    onRestart={onRestart}
                    onRollback={onRollback}
                    onLogs={onLogs}
                    onBuild={onBuild}
                    onViewBuild={onViewBuild}
                    onSyncBuild={onSyncBuild}
                    onSyncRegistry={onSyncRegistry}
                  />
                )
              })}
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
