import { useRef } from 'react'
import type { EnvironmentDashboard, ReleaseComparison, RunningRelease, ServiceStatus } from '../../../lib/types'
import { githubServiceForAgentCode } from '../../../lib/github/serviceMap'
import { extractDigest } from '../../../lib/serviceStatus'
import { CopyableValue } from './CopyableValue'
import {
  StatusBadge,
  buildStatusLabel,
  buildStatusTone,
  containerStatusLabel,
  containerStatusTone,
  hasHealthCheck,
  healthLabel,
  healthTone,
  primaryComparisonBadge,
  resolvedReleaseSourceLabel,
  resolvedReleaseSourceTone,
  runningReleaseStatusLabel,
  type BadgeTone,
} from './StatusBadge'
import type { BuildTrackedState } from './useBuildTracker'

type ServiceCardProps = {
  environment: EnvironmentDashboard
  service: ServiceStatus
  nextEnvironment?: EnvironmentDashboard
  previousEnvironment?: EnvironmentDashboard
  previousService?: ServiceStatus
  // Latest Build vs DEV vs UAT vs PROD — see lib/releaseComparison.ts. Only
  // computed for the DEV card (same placement rule as Build below).
  comparison?: ReleaseComparison
  // Card/Table toggle for the comparison view (see Dashboard.tsx) — false
  // hides this card's flow block so it isn't shown twice at once alongside
  // LatestReleasePanel's table.
  showComparisonBlock: boolean
  registrySyncing?: boolean
  deployingLatest?: boolean
  isBusy: boolean
  buildState?: BuildTrackedState
  onDeploy: (environment: EnvironmentDashboard, service: ServiceStatus, prefillDigest?: string) => Promise<void>
  onPromote: (environment: EnvironmentDashboard, service: ServiceStatus) => Promise<void>
  onRestart: (environment: EnvironmentDashboard, service: ServiceStatus) => Promise<void>
  onRollback: (environment: EnvironmentDashboard, service: ServiceStatus) => Promise<void>
  onLogs: (environment: EnvironmentDashboard, service: ServiceStatus) => Promise<void>
  onBuild: (environment: EnvironmentDashboard, service: ServiceStatus) => void
  onViewBuild: (service: ServiceStatus) => void
  onSyncBuild: (service: ServiceStatus) => void
  onSyncRegistry: (service: ServiceStatus) => Promise<void>
  onDeployLatestToDev: (service: ServiceStatus) => Promise<void>
  onViewTimeline: (service: ServiceStatus) => void
}

const BUTTON_BASE =
  'flex min-h-[38px] items-center justify-center rounded px-3.5 text-center text-sm font-medium whitespace-nowrap transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1'

const BUTTON_VARIANTS = {
  primary: 'bg-emerald-600 text-white hover:bg-emerald-500 focus-visible:outline-emerald-600',
  secondary:
    'border border-slate-800 bg-transparent text-slate-300 hover:border-slate-700 hover:bg-slate-800/60 focus-visible:outline-slate-500',
}

const MENU_ITEM =
  'flex w-full items-center rounded px-3 py-2 text-left text-xs font-medium text-slate-300 transition-colors duration-150 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40'
const MENU_ITEM_DANGER = 'flex w-full items-center rounded px-3 py-2 text-left text-xs font-medium text-rose-400 transition-colors duration-150 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-40'

export function ServiceCard({
  environment,
  service,
  nextEnvironment,
  previousEnvironment,
  previousService,
  comparison,
  showComparisonBlock,
  registrySyncing,
  deployingLatest,
  isBusy,
  buildState,
  onDeploy,
  onPromote,
  onRestart,
  onRollback,
  onLogs,
  onBuild,
  onViewBuild,
  onSyncBuild,
  onSyncRegistry,
  onDeployLatestToDev,
  onViewTimeline,
}: ServiceCardProps) {
  const disabled = isBusy || !environment.online
  const menuRef = useRef<HTMLDetailsElement>(null)

  function closeMenu() {
    menuRef.current?.removeAttribute('open')
  }

  // Build/comparison only make sense on the first environment in the chain
  // (source of truth for what gets built), and only for services the
  // GitHub workflow actually knows how to build.
  const githubService = !previousEnvironment ? githubServiceForAgentCode(service.code) : null
  const canBuild = Boolean(githubService)
  const buildBusy = buildState?.status === 'triggering' || buildState?.status === 'queued' || buildState?.status === 'in_progress'
  const showComparison = !previousEnvironment && Boolean(githubService) && Boolean(comparison) && showComparisonBlock

  const badge = comparison ? primaryComparisonBadge(comparison) : undefined
  const tracked = hasHealthCheck(service.health)

  // We only have a precise, state-driven answer ("is there actually a new
  // build to deploy to DEV") on the DEV card, once comparison data has
  // loaded. Everywhere else (UAT/PROD cards, or DEV before that data is
  // ready) there is no such signal, so the plain "Triển khai" (manual
  // digest entry) stays the primary action there — unchanged from before.
  const hasComparisonData = showComparison && Boolean(comparison)
  const canDeployLatest = hasComparisonData && Boolean(comparison?.canDeployLatestToDev)
  // Whether clicking the primary button will import a Release Snapshot
  // first (see onDeployLatestToDev in Dashboard.tsx) — the label must say so
  // up front, not just "Triển khai bản mới", so the user isn't surprised by
  // an extra import step happening before the deploy they asked for.
  const needsImportFirst = canDeployLatest && Boolean(comparison?.canImportSnapshot)
  // Reuses the resolver's OWN conclusion (already computed in `warnings`)
  // instead of re-deriving a digest comparison here — this component must
  // never decide sync/outdated facts itself, only render what
  // lib/releaseComparison.ts already decided.
  const uatDiffersFromDev = Boolean(comparison?.warnings.includes('UAT khác DEV'))
  // When Latest already matches DEV, showing a bare "Triển khai" would be
  // ambiguous about which artifact it targets — hide it entirely instead,
  // and let "Chuyển tiếp → UAT" take the prominent slot if that's the
  // actual next actionable step.
  const promoteIsPrimary = hasComparisonData && !canDeployLatest && uatDiffersFromDev && Boolean(nextEnvironment)
  const primaryBusy = canDeployLatest && deployingLatest

  return (
    <section className="flex w-full min-w-0 flex-col rounded-lg border border-slate-800 bg-slate-900/50 p-4 transition-colors duration-150 hover:border-slate-700">
      <div className="mb-2.5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-slate-100">{service.displayName || service.code}</h3>
          <code className="text-xs text-slate-600">{service.code}</code>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <StatusBadge tone={containerStatusTone(service.status)} label={containerStatusLabel(service.status)} />
          {tracked ? <StatusBadge tone={healthTone(service.health)} label={healthLabel(service.health)} /> : null}
        </div>
      </div>

      {showComparison && comparison && badge ? (
        <div className="mb-3">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span title={badge.tooltip} className="cursor-default">
              <StatusBadge tone={badge.tone} label={badge.label} />
            </span>
          </div>
          {comparison.warnings.length > 0 ? (
            <p title={comparison.warnings.join(' · ')} className="m-0 truncate text-xs text-slate-500">
              {comparison.warnings[0]}
              {comparison.warnings.length > 1 ? ` (+${comparison.warnings.length - 1})` : ''}
            </p>
          ) : null}
        </div>
      ) : null}

      {!showComparison ? (
        <div className="mb-3 flex min-w-0 items-center gap-2 text-sm">
          <CopyableValue value={service.repoDigest} className="text-sm" hoverReveal />
          <span className="shrink-0 text-xs text-slate-600">{formatDate(service.startedAt)}</span>
        </div>
      ) : null}

      {showComparison && comparison ? (
        <>
          <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="text-xs tracking-wide text-slate-500 uppercase">Latest Build</span>
            <span className="font-mono text-slate-200">{comparison.latest?.tag ?? '--'}</span>
            {comparison.latest ? (
              <CopyableValue value={comparison.latest.repoDigest} className="text-xs" hoverReveal />
            ) : (
              <span className="text-xs text-slate-600">--</span>
            )}
            <span className="text-xs text-slate-600">{formatDate(comparison.latest?.createdAt)}</span>
            {comparison.latest ? (
              <StatusBadge tone={resolvedReleaseSourceTone(comparison.latest.source)} label={resolvedReleaseSourceLabel(comparison.latest.source)} />
            ) : null}
          </div>

          <ReleaseFlow comparison={comparison} nextEnvironmentCode={nextEnvironment?.code} />
        </>
      ) : null}

      {!showComparison && previousEnvironment ? (
        <div className="mb-3 rounded border border-slate-800/70 bg-slate-950/30 px-2.5 py-2 text-xs leading-relaxed">
          {service.repoDigest && previousService?.repoDigest && service.repoDigest === previousService.repoDigest ? (
            <span className="text-emerald-400">✓ Đồng bộ với {previousEnvironment.code}</span>
          ) : (
            <span className="text-amber-400">Khác {previousEnvironment.code}</span>
          )}
        </div>
      ) : null}

      {canBuild && buildState && (buildState.status !== 'success' || !showComparison) ? (
        <div className="mb-3 rounded border border-slate-800/70 bg-slate-950/30 px-2.5 py-2 text-xs leading-relaxed">
          <div className="flex items-center justify-between gap-2">
            <StatusBadge tone={buildStatusTone(buildState.status)} label={buildStatusLabel(buildState.status)} />
            {buildState.runId ? (
              <span className="text-slate-600">
                Run #{buildState.runId}
                {buildState.runAttempt ? ` · Attempt ${buildState.runAttempt}` : ''}
              </span>
            ) : null}
          </div>
          {buildState.status === 'failed' && buildState.error ? <p className="mt-1.5 break-words text-rose-300">{buildState.error}</p> : null}
        </div>
      ) : null}

      {service.error ? <div className="mb-3 text-xs break-words text-rose-400">{service.error}</div> : null}

      <details className="mb-3 text-xs text-slate-500">
        <summary className="cursor-pointer select-none hover:text-slate-400">Chi tiết kỹ thuật</summary>
        <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1.5">
          <div className="col-span-2 min-w-0">
            <dt className="mb-0.5 text-[10px] tracking-wide text-slate-600 uppercase">Image</dt>
            <dd className="m-0">
              <CopyableValue value={service.imageRef} className="text-xs" />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="mb-0.5 text-[10px] tracking-wide text-slate-600 uppercase">Git Revision</dt>
            <dd className="m-0 truncate text-slate-400">{service.gitRevision ? service.gitRevision.slice(0, 12) : '--'}</dd>
          </div>
          <div className="min-w-0">
            <dt className="mb-0.5 text-[10px] tracking-wide text-slate-600 uppercase">Khởi động lúc</dt>
            <dd className="m-0 truncate text-slate-400">{formatDate(service.startedAt)}</dd>
          </div>
          <div className="col-span-2 min-w-0">
            <dt className="mb-0.5 text-[10px] tracking-wide text-slate-600 uppercase">Image ID (local, debug)</dt>
            <dd className="m-0">
              <CopyableValue value={service.imageId} className="text-xs" />
            </dd>
          </div>
        </dl>
      </details>

      <div className="mt-auto flex items-center gap-2">
        {canDeployLatest ? (
          <button
            type="button"
            disabled={disabled || primaryBusy}
            onClick={() => void onDeployLatestToDev(service)}
            title={comparison?.dev?.repoDigest ? `Digest nguồn: ${comparison.latest?.repoDigest}\nDigest DEV hiện tại: ${comparison.dev.repoDigest}` : undefined}
            className={`${BUTTON_BASE} ${BUTTON_VARIANTS.primary} flex-1`}
          >
            {primaryBusy ? 'Đang triển khai…' : needsImportFirst ? 'Đồng bộ & triển khai → DEV' : 'Triển khai bản mới → DEV'}
          </button>
        ) : !hasComparisonData ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => void onDeploy(environment, service)}
            className={`${BUTTON_BASE} ${BUTTON_VARIANTS.primary} flex-1`}
          >
            Triển khai
          </button>
        ) : null}
        {nextEnvironment ? (
          <button
            type="button"
            disabled={disabled || !service.repoDigest}
            onClick={() => void onPromote(environment, service)}
            title={`Sẽ lấy digest đang chạy ở ${environment.code} (không phải Latest Build)`}
            className={`${BUTTON_BASE} ${BUTTON_VARIANTS[promoteIsPrimary ? 'primary' : 'secondary']} flex-1`}
          >
            Chuyển tiếp → {nextEnvironment.code}
          </button>
        ) : null}
        <details ref={menuRef} className="relative shrink-0">
          <summary
            className="flex min-h-[38px] cursor-pointer list-none items-center justify-center rounded border border-slate-800 bg-transparent px-3 text-sm font-medium text-slate-300 transition-colors duration-150 hover:border-slate-700 hover:bg-slate-800/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-500 [&::-webkit-details-marker]:hidden"
            aria-label="Thao tác khác"
          >
            ⋯
          </summary>
          <div className="absolute right-0 z-10 mt-1.5 w-56 rounded-lg border border-slate-800 bg-slate-900 p-1.5 shadow-2xl shadow-black/50">
            {canBuild ? (
              <button
                type="button"
                disabled={disabled || buildBusy}
                onClick={() => {
                  closeMenu()
                  onBuild(environment, service)
                }}
                className={MENU_ITEM}
              >
                Build lại
              </button>
            ) : null}
            {showComparison && comparison?.canImportSnapshot ? (
              <button
                type="button"
                disabled={disabled || registrySyncing}
                onClick={() => {
                  closeMenu()
                  void onSyncRegistry(service)
                }}
                title="Đọc digest hiện tại của tag latest trên Docker Hub và tạo Release Snapshot nếu có bản mới — không build lại"
                className={MENU_ITEM}
              >
                {registrySyncing ? 'Đang đồng bộ…' : 'Đồng bộ từ Docker Hub'}
              </button>
            ) : null}
            {hasComparisonData ? (
              // The precise, state-driven primary action already covers the
              // common case — this stays reachable as an explicit advanced
              // override (e.g. deploying a digest that isn't Latest Build),
              // never as an ambiguous default button.
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  closeMenu()
                  void onDeploy(environment, service)
                }}
                title="Nhập trực tiếp một repoDigest để triển khai — dùng khi cần một phiên bản khác ngoài Latest Build"
                className={MENU_ITEM}
              >
                Triển khai thủ công (nhập digest)
              </button>
            ) : null}
            {canBuild && buildState?.runId ? (
              <button
                type="button"
                onClick={() => {
                  closeMenu()
                  onViewBuild(service)
                }}
                className={MENU_ITEM}
              >
                {buildState.status === 'failed' ? 'Xem lỗi build' : 'Xem chi tiết build'}
              </button>
            ) : null}
            {canBuild && (buildState?.status === 'success' || buildState?.status === 'failed') ? (
              <button
                type="button"
                onClick={() => {
                  closeMenu()
                  onSyncBuild(service)
                }}
                title="Đọc lại trạng thái build hiện tại từ GitHub — hữu ích sau khi Re-run trực tiếp trên GitHub"
                className={MENU_ITEM}
              >
                Đồng bộ trạng thái build
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                closeMenu()
                onViewTimeline(service)
              }}
              className={MENU_ITEM}
            >
              Xem dòng thời gian phiên bản
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                closeMenu()
                void onLogs(environment, service)
              }}
              className={MENU_ITEM}
            >
              Xem nhật ký
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                closeMenu()
                void onRestart(environment, service)
              }}
              className={MENU_ITEM}
            >
              Khởi động lại
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                closeMenu()
                void onRollback(environment, service)
              }}
              className={MENU_ITEM_DANGER}
            >
              Quay lại phiên bản
            </button>
          </div>
        </details>
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
  return value.length > 20 ? `${value.slice(0, 14)}…${value.slice(-6)}` : value
}

// Compact Latest → DEV → UAT → PROD chain — each node is only ever a short
// digest (monospace, tooltip + copy-on-hover) plus one status dot, nothing
// else. Repository/tag/commit/source live once in the Latest Build summary
// above, never repeated per node.
function ReleaseFlow({ comparison, nextEnvironmentCode }: { comparison: ReleaseComparison; nextEnvironmentCode?: string }) {
  const latestDigest = extractDigest(comparison.latest?.repoDigest)
  const devDigest = extractDigest(comparison.dev?.repoDigest)
  const uatDigest = extractDigest(comparison.uat?.repoDigest)
  const prodDigest = extractDigest(comparison.prod?.repoDigest)

  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5">
      <FlowNode label="Latest" value={comparison.latest?.repoDigest} tone={latestNodeTone(comparison)} />
      <FlowArrow />
      {/* No "Rollback" note here: DEV differing from Latest only means DEV
          hasn't (yet) run this build — it is NOT evidence of a rollback.
          A real rollback claim needs proof (an older known snapshot AND a
          confirmed newer deploy that preceded it, or an audit record whose
          action is rollback) that this component does not have access to.
          Add a resolver-computed `isRollback` field to ReleaseComparison /
          RunningRelease if/when that evidence becomes available — never
          infer it here from `state` alone. */}
      <FlowNode
        label="DEV"
        value={comparison.dev?.repoDigest}
        tone={nodeTone(devDigest, latestDigest, comparison.dev)}
        running={comparison.dev}
      />
      <FlowArrow />
      <FlowNode label="UAT" value={comparison.uat?.repoDigest} tone={nodeTone(uatDigest, devDigest, comparison.uat)} running={comparison.uat} />
      {nextEnvironmentCode || comparison.prod ? (
        <>
          <FlowArrow />
          <FlowNode label="PROD" value={comparison.prod?.repoDigest} tone={nodeTone(prodDigest, uatDigest, comparison.prod)} running={comparison.prod} />
        </>
      ) : null}
    </div>
  )
}

function nodeTone(digest: string | undefined, reference: string | undefined, running: RunningRelease | undefined): BadgeTone {
  if (running?.error) return 'danger'
  if (!digest || !reference) return 'neutral'
  return digest === reference ? 'success' : 'warning'
}

// LATEST has no `running` container to compare against (it's Docker Hub's
// tag, not a deployed environment) — its tone instead reflects whether
// Release Control actually knows this digest yet, reusing the resolver's own
// conclusion (comparison.canImportSnapshot, from lib/releaseComparison.ts)
// instead of re-deriving that here:
//   neutral (gray)  — no digest at all (nothing loaded / Docker Hub empty)
//   warning (amber) — valid digest, but no Release Snapshot yet (external
//                      build not imported/synced — see "Đồng bộ từ Docker
//                      Hub")
//   success (green) — digest resolves to a known Release Snapshot
// There is deliberately no `danger` (red) case: ResolvedRelease carries no
// "Docker Hub fetch actually failed" signal today (a failed lookup and "no
// latest tag published" both collapse to `comparison.latest` being
// undefined — see resolveLatestRelease) — inventing a red state here would
// be guessing, not deriving.
function latestNodeTone(comparison: ReleaseComparison): BadgeTone {
  if (!comparison.latest?.repoDigest) return 'neutral'
  return comparison.canImportSnapshot ? 'warning' : 'success'
}

function FlowArrow() {
  return (
    <span className="shrink-0 text-slate-700" aria-hidden>
      →
    </span>
  )
}

const DOT_CLASS: Record<BadgeTone, string> = {
  success: 'bg-emerald-400',
  warning: 'bg-amber-400',
  danger: 'bg-rose-400',
  neutral: 'bg-slate-600',
}

function FlowNode({ label, value, tone, running, note }: { label: string; value?: string; tone: BadgeTone; running?: RunningRelease; note?: string }) {
  const statusTitle = running ? (running.error ?? runningReleaseStatusLabel(running.containerStatus)) : undefined
  return (
    <div className="group flex min-w-0 shrink-0 items-center gap-1.5 rounded border border-slate-800/70 bg-slate-950/40 px-2 py-1.5">
      <span title={statusTitle} className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[tone]}`} aria-hidden />
      <div className="min-w-0">
        <p className="m-0 text-[10px] leading-none tracking-wide text-slate-500 uppercase">
          {label}
          {note ? <span className="ml-1 text-amber-400 normal-case">· {note}</span> : null}
        </p>
        {value ? (
          <CopyableValue value={value} className="mt-0.5 text-xs" truncate={false} hoverReveal formatDisplay={shortDigest} />
        ) : (
          <p className="m-0 mt-0.5 text-xs text-slate-600">{running?.error ? 'Lỗi' : '--'}</p>
        )}
      </div>
    </div>
  )
}
