import { BUILD_SERVICES, githubServiceForAgentCode, type BuildServiceCode } from '../../../lib/github/serviceMap'
import { extractDigest } from '../../../lib/serviceStatus'
import type { EnvironmentDashboard, RegistryServiceStatus } from '../../../lib/types'
import { StatusBadge, resolvedReleaseSourceLabel, resolvedReleaseSourceTone } from './StatusBadge'

type LatestReleasePanelProps = {
  registryStatus: RegistryServiceStatus[]
  environments: EnvironmentDashboard[]
  lastCheckedAt?: string
  onRefresh: () => void
}

/**
 * "Latest Build vs DEV vs UAT vs PROD" per service, all 7 rows at once.
 * Deliberately built entirely from data the dashboard already polls —
 * /api/registry/status (latestBuild) and /api/dashboard (live environment
 * digests) — no new network call. Every match/mismatch is a direct
 * repoDigest comparison, never a tag or a build timestamp.
 */
export function LatestReleasePanel({ registryStatus, environments, lastCheckedAt, onRefresh }: LatestReleasePanelProps) {
  return (
    <section className="mt-5 w-full rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-200">So sánh phiên bản mới nhất</h2>
          <p className="text-xs text-slate-500">Latest Build (Docker Hub) so với từng môi trường — theo repoDigest bất biến.</p>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="text-xs text-slate-600">Kiểm tra lúc {formatCheckedAt(lastCheckedAt)}</span>
          <button
            type="button"
            onClick={onRefresh}
            className="min-h-[30px] rounded border border-slate-800 bg-slate-900/60 px-3 text-xs font-medium text-slate-200 transition-colors duration-150 hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
          >
            Làm mới
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-left text-slate-500">
              <th className="py-2 pr-3 font-medium">Dịch vụ</th>
              <th className="py-2 pr-3 font-medium">Latest Build</th>
              {environments.map((environment) => (
                <th key={environment.code} className="py-2 pr-3 font-medium">
                  {environment.code}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {BUILD_SERVICES.map((service) => (
              <ServiceRow key={service} service={service} registryStatus={registryStatus} environments={environments} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ServiceRow({
  service,
  registryStatus,
  environments,
}: {
  service: BuildServiceCode
  registryStatus: RegistryServiceStatus[]
  environments: EnvironmentDashboard[]
}) {
  const status = registryStatus.find((item) => item.service === service)
  const latestBuild = status?.latestBuild
  const latestBuildDigest = latestBuild ? extractDigest(latestBuild.repoDigest) : undefined

  return (
    <tr className="border-b border-slate-800/70 align-top">
      <td className="py-2.5 pr-3 font-medium text-slate-200">{service}</td>
      <td className="py-2.5 pr-3">
        {latestBuild ? (
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-slate-300">{latestBuild.tag}</span>
              <StatusBadge tone={resolvedReleaseSourceTone(latestBuild.source)} label={resolvedReleaseSourceLabel(latestBuild.source)} />
            </div>
            <span title={latestBuild.repoDigest} className="font-mono text-slate-500">
              {shortDigest(latestBuildDigest)}
            </span>
            {latestBuild.branch || latestBuild.commitSha ? (
              <span className="text-slate-500">
                {latestBuild.branch ?? '--'}
                {latestBuild.commitSha ? ` · ${latestBuild.commitSha.slice(0, 10)}` : ''}
              </span>
            ) : null}
            {latestBuild.workflowRunUrl ? (
              <a href={latestBuild.workflowRunUrl} target="_blank" rel="noreferrer" className="text-emerald-400 hover:underline">
                Xem run #{latestBuild.workflowRunId}
              </a>
            ) : null}
          </div>
        ) : (
          <span className="text-slate-600">Không có dữ liệu Docker Hub</span>
        )}
      </td>
      {environments.map((environment) => {
        const service_ = environment.services.find((item) => githubServiceForAgentCode(item.code) === service)
        const envDigest = extractDigest(service_?.repoDigest)
        return (
          <td key={environment.code} className="py-2.5 pr-3">
            {envDigest ? (
              <div className="flex flex-col gap-1">
                <span title={service_?.repoDigest} className="font-mono text-slate-400">
                  {shortDigest(envDigest)}
                </span>
                {latestBuildDigest ? (
                  envDigest === latestBuildDigest ? (
                    <span className="text-emerald-400">Khớp</span>
                  ) : (
                    <span className="text-amber-400">Lệch</span>
                  )
                ) : null}
              </div>
            ) : (
              <span className="text-slate-600">--</span>
            )}
          </td>
        )
      })}
    </tr>
  )
}

function shortDigest(value?: string): string {
  if (!value) return '--'
  return value.length > 22 ? `${value.slice(0, 18)}…${value.slice(-6)}` : value
}

function formatCheckedAt(value?: string): string {
  if (!value) return '--'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '--' : date.toLocaleTimeString('vi-VN')
}
