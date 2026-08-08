import type { EnvironmentDashboard } from '../../../lib/types'
import { displayEnvironmentName } from './environmentDisplay'

type EnvironmentTabsProps = {
  environments: EnvironmentDashboard[]
  activeEnvironment: string
  onChange: (code: string) => void
}

function healthyCount(environment: EnvironmentDashboard): { healthy: number; total: number } {
  const total = environment.services.length
  const healthy = environment.services.filter(
    (service) => service.status === 'running' && (service.health === 'healthy' || service.health === 'none'),
  ).length
  return { healthy, total }
}

export function EnvironmentTabs({ environments, activeEnvironment, onChange }: EnvironmentTabsProps) {
  return (
    <div className="mb-5 w-full overflow-x-auto">
      <div className="flex w-max min-w-full gap-1 border-b border-slate-800">
        {environments.map((environment) => {
          const active = environment.code === activeEnvironment
          const { healthy, total } = healthyCount(environment)
          return (
            <button
              key={environment.code}
              type="button"
              onClick={() => onChange(environment.code)}
              aria-current={active ? 'true' : undefined}
              className={`flex shrink-0 items-center gap-2 border-b-2 px-4 py-2.5 text-left transition-colors duration-150 ${
                active
                  ? 'border-emerald-500 bg-slate-900/50 text-slate-100'
                  : 'border-transparent text-slate-400 hover:bg-slate-900/30 hover:text-slate-200'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${environment.online ? 'bg-emerald-400' : 'bg-rose-400'}`}
                aria-hidden
              />
              <span className="flex flex-col leading-tight">
                <span className="text-sm font-medium">{displayEnvironmentName(environment.name)}</span>
                <span className="text-[10px] tracking-wide text-slate-500">
                  {environment.code}
                  {environment.online ? ` · ${healthy}/${total}` : ' · Mất kết nối'}
                </span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
