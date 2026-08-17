'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AuditRecord,
  DashboardResponse,
  EnvironmentDashboard,
  OperationAction,
  OperationLogLine,
  OperationSnapshot,
  OperationStatus,
  ServiceStatus,
} from '../../lib/types'
import { githubServiceForAgentCode } from '../../lib/github/serviceMap'
import type { BuildServiceCode } from '../../lib/github/serviceMap'
import { readJsonSafe } from '../../lib/http'
import { escapeHtml, SwalAlert } from '../../lib/swalAlert'
import type { AuditFilter } from './release-control/AuditLogPanel'
import { AuditLogPanel } from './release-control/AuditLogPanel'
import { BuildDetailDrawer } from './release-control/BuildDetailDrawer'
import { BuildDialog } from './release-control/BuildDialog'
import { DashboardHeader } from './release-control/DashboardHeader'
import { EnvironmentPanel } from './release-control/EnvironmentPanel'
import { EnvironmentTabs } from './release-control/EnvironmentTabs'
import { LogsModal } from './release-control/LogsModal'
import { OperationLogDrawer } from './release-control/OperationLogDrawer'
import type { ActiveOperation } from './release-control/OperationLogDrawer'
import { SummaryCards } from './release-control/SummaryCards'
import type { BuildTrackedStatus } from './release-control/useBuildTracker'
import { useBuildTracker } from './release-control/useBuildTracker'

type Props = { username: string }

type BusyAction = { key: string; label: string } | null

const OPERATION_ACTION_LABEL: Record<OperationAction, string> = {
  deploy: 'Triển khai',
  restart: 'Khởi động lại',
  rollback: 'Quay lại phiên bản',
}

const OPERATION_FAIL_VERB: Record<OperationAction, string> = {
  deploy: 'triển khai',
  restart: 'khởi động lại',
  rollback: 'quay lại phiên bản',
}

const CONNECTION_LOST_MESSAGE =
  'Mất kết nối tới luồng nhật ký của thao tác này và không thể lấy lại trạng thái. Vui lòng dùng "Làm mới" để kiểm tra trạng thái dịch vụ mới nhất.'

// Reconnect attempts (ms) before giving up on an SSE drop, whether it's the
// first connection attempt or a later mid-stream disconnect.
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000]

type ConnectionState = 'connected' | 'reconnecting' | 'lost'

export default function Dashboard({ username }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null)
  const [audit, setAudit] = useState<AuditRecord[]>([])
  const [auditStorageNotConfigured, setAuditStorageNotConfigured] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<BusyAction>(null)
  const [logs, setLogs] = useState<{ title: string; content: string } | null>(null)
  const [activeEnvironmentCode, setActiveEnvironmentCode] = useState<string>(() => searchParams.get('env') ?? '')
  const [auditFilter, setAuditFilter] = useState<AuditFilter>('current')

  // The drawer's visibility (activeOperation) is intentionally separate from
  // the operation being tracked (trackedOperation): closing the drawer must
  // not cancel the job or stop us from clearing `busy` / refreshing once it
  // settles, per the "Close only closes the UI" requirement.
  const [activeOperation, setActiveOperation] = useState<ActiveOperation | null>(null)
  const [trackedOperation, setTrackedOperation] = useState<ActiveOperation | null>(null)
  const [operationLogs, setOperationLogs] = useState<OperationLogLine[]>([])
  const [operationStatus, setOperationStatus] = useState<OperationStatus>('running')
  const [operationError, setOperationError] = useState<string | undefined>()
  const [connectionState, setConnectionState] = useState<ConnectionState>('connected')

  // Build (GitHub Actions -> Docker Hub) is tracked entirely independently of
  // the deploy/restart/rollback/promote operation model above: it never
  // touches a running container, so it gets its own state and its own
  // dialog/drawer instead of reusing `busy` / `activeOperation`.
  const { builds, getBuildState, triggerBuild, syncBuild, hydrateFromServer } = useBuildTracker()
  const [buildDialogTarget, setBuildDialogTarget] = useState<{ environment: EnvironmentDashboard; service: ServiceStatus } | null>(null)
  const [buildDetailTarget, setBuildDetailTarget] = useState<{ githubService: string; serviceLabel: string } | null>(null)
  const previousBuildStatuses = useRef<Record<string, BuildTrackedStatus>>({})

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const [dashboardResponse, auditResponse] = await Promise.all([
        fetch('/api/dashboard', { cache: 'no-store' }),
        fetch('/api/audit?limit=30', { cache: 'no-store' }),
      ])
      if (dashboardResponse.status === 401 || auditResponse.status === 401) {
        window.location.href = '/login'
        return
      }
      const dashboardBody = await readJsonSafe<DashboardResponse & { details?: string; error?: string }>(dashboardResponse)
      const auditBody = await readJsonSafe<{ items?: AuditRecord[]; details?: string; error?: string }>(auditResponse)
      if (!dashboardResponse.ok) throw new Error(dashboardBody?.details ?? dashboardBody?.error ?? 'Không tải được dashboard')
      if (!dashboardBody) throw new Error('Không tải được dashboard')
      setDashboard(dashboardBody)

      // Audit storage not being configured (Vercel without KV) must not take
      // the whole dashboard down — only the audit panel needs to know, so it
      // can show a distinct "not configured" message instead of an empty
      // history. Any OTHER audit fetch failure is treated the same way
      // (fail soft): the rest of the app stays usable either way.
      if (auditResponse.ok) {
        setAudit(auditBody?.items ?? [])
        setAuditStorageNotConfigured(false)
      } else {
        setAudit([])
        setAuditStorageNotConfigured(auditBody?.error === 'audit_storage_not_configured')
      }
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không tải được dữ liệu')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(true), 15_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  // Loads each buildable service's latest GitHub Actions build state
  // straight from the server as soon as the dashboard knows which services
  // those are (DEV environment services that map to a build-service code) —
  // regardless of whether this browser/device ever triggered or tracked
  // that build itself. hydrateFromServer is a cheap no-op for services
  // already confirmed this session, so re-running this on every dashboard
  // refresh (not just the first) also means a service whose discovery
  // failed once (e.g. a transient GitHub API error) gets retried instead of
  // being stuck showing only "Build" forever.
  useEffect(() => {
    const devEnvironment = dashboard?.environments?.[0]
    if (!devEnvironment) return
    const buildableServices = devEnvironment.services
      .map((service) => githubServiceForAgentCode(service.code))
      .filter((code): code is BuildServiceCode => code !== null)
    if (buildableServices.length === 0) return
    hydrateFromServer(buildableServices)
  }, [dashboard, hydrateFromServer])

  // Toasts the terminal outcome of a build exactly once, by diffing against
  // the status seen on the previous render — polling itself lives inside
  // useBuildTracker. The server writes the build's audit record as part of
  // the poll request that first observes "completed" (see
  // /api/builds/[runId]), so by the time this effect sees the status
  // transition, refreshing /api/audit is guaranteed to pick it up.
  //
  // Both branches require previousStatus !== undefined: after a page
  // refresh, useBuildTracker rehydrates a previously-tracked build and its
  // FIRST appearance in `builds` can already be 'success' or 'failed' (from
  // the live re-query, not stale memory) — without this guard that would
  // read as a fresh transition and pop a toast for a build that actually
  // finished in an earlier session.
  useEffect(() => {
    for (const [service, state] of Object.entries(builds)) {
      const previousStatus = previousBuildStatuses.current[service]
      if (previousStatus !== state.status) {
        if (state.status === 'success' && previousStatus !== undefined) {
          SwalAlert.toast(`Build ${service} thành công`)
          void refresh(true)
        } else if (state.status === 'failed' && previousStatus !== undefined) {
          SwalAlert.toast(`Build ${service} thất bại`, 'error')
          void refresh(true)
        }
      }
    }
    previousBuildStatuses.current = Object.fromEntries(Object.entries(builds).map(([service, state]) => [service, state.status]))
  }, [builds, refresh])

  // Reconciles the active tab against the loaded environments: keeps a valid
  // `?env=` from the URL, otherwise falls back to the first environment by
  // order. Runs again after every dashboard reload in case the previously
  // active environment code disappears from config.
  useEffect(() => {
    const environmentList = dashboard?.environments ?? []
    if (environmentList.length === 0) return
    const stillValid = environmentList.some((item) => item.code === activeEnvironmentCode)
    if (!stillValid) {
      setActiveEnvironmentCode(environmentList[0].code)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboard])

  function handleEnvironmentChange(code: string) {
    setActiveEnvironmentCode(code)
    const params = new URLSearchParams(searchParams.toString())
    params.set('env', code)
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }

  // Follows a single operation's realtime log stream until it reaches a
  // terminal status, independent of whether the drawer is currently shown.
  // Reconnects with backoff on drops (network blip, agent restart, proxy
  // hiccup) instead of freezing the drawer on the first error.
  useEffect(() => {
    if (!trackedOperation) return
    const operation = trackedOperation
    const streamUrl = `/api/operations/${encodeURIComponent(operation.operationId)}/stream?environment=${encodeURIComponent(operation.environment)}`

    let cancelled = false
    let attempt = 0
    let source: EventSource | null = null
    let retryTimer: number | null = null

    function devLog(event: string, extra?: Record<string, unknown>) {
      if (process.env.NODE_ENV === 'production') return
      // eslint-disable-next-line no-console
      console.debug('[operation-stream]', event, {
        operationId: operation.operationId,
        environment: operation.environment,
        attempt,
        ...extra,
      })
    }

    function connect() {
      if (cancelled) return
      devLog('connecting', { url: streamUrl })
      const es = new EventSource(streamUrl)
      source = es

      es.addEventListener('log', (event) => {
        attempt = 0
        setConnectionState('connected')
        const line = JSON.parse((event as MessageEvent).data) as OperationLogLine
        setOperationLogs((prev) => (prev.some((item) => item.index === line.index) ? prev : [...prev, line]))
      })

      es.addEventListener('status', (event) => {
        const snapshot = JSON.parse((event as MessageEvent).data) as OperationSnapshot
        devLog('status', { status: snapshot.status })
        es.close()
        setConnectionState('connected')
        void settleOperation(operation, snapshot)
      })

      es.onopen = () => {
        attempt = 0
        setConnectionState('connected')
      }

      es.onerror = () => {
        devLog('error', { readyState: es.readyState })
        es.close()
        if (cancelled) return
        if (attempt >= RECONNECT_DELAYS_MS.length) {
          setConnectionState('lost')
          void settleOperation(operation)
          return
        }
        setConnectionState('reconnecting')
        const delay = RECONNECT_DELAYS_MS[attempt]
        attempt += 1
        retryTimer = window.setTimeout(connect, delay)
      }
    }

    connect()

    return () => {
      cancelled = true
      source?.close()
      if (retryTimer !== null) window.clearTimeout(retryTimer)
    }
  }, [trackedOperation])

  async function settleOperation(operation: ActiveOperation, snapshot?: OperationSnapshot) {
    let finalStatus: OperationStatus = snapshot?.status ?? 'failed'
    let finalError: string | undefined = snapshot?.error
    let finalLogs: OperationLogLine[] = snapshot?.logs ?? []

    try {
      const response = await fetch(
        `/api/operations/${encodeURIComponent(operation.operationId)}?environment=${encodeURIComponent(operation.environment)}`,
        { cache: 'no-store' },
      )
      const data = response.ok ? await readJsonSafe<OperationSnapshot>(response) : null
      if (data) {
        finalLogs = data.logs
        finalStatus = data.status
        finalError = data.error
      } else if (!snapshot) {
        // Neither the SSE stream nor this fallback fetch could reach the
        // operation. Surface that clearly instead of leaving the drawer
        // frozen on stale "running" / empty-logs state.
        finalStatus = 'failed'
        finalError = CONNECTION_LOST_MESSAGE
      }
    } catch {
      if (!snapshot) {
        finalStatus = 'failed'
        finalError = CONNECTION_LOST_MESSAGE
      }
    } finally {
      setOperationLogs(finalLogs)
      setOperationStatus(finalStatus)
      setOperationError(finalError)
      setConnectionState('connected')
      setBusy(null)
      setTrackedOperation(null)
      await refresh(true)
      if (finalStatus === 'success') {
        await SwalAlert.success(`${operation.actionLabel} thành công`)
      } else {
        await SwalAlert.error(
          `Không thể ${operation.failVerb ?? OPERATION_FAIL_VERB[operation.action]} ${operation.serviceLabel}.`,
          { detail: finalError },
        )
      }
    }
  }

  async function startOperation(
    key: string,
    url: string,
    body: unknown,
    environment: EnvironmentDashboard,
    service: ServiceStatus,
    action: OperationAction,
    overrides?: { actionLabel?: string; failVerb?: string },
  ) {
    const actionLabel = overrides?.actionLabel ?? OPERATION_ACTION_LABEL[action]
    setBusy({ key, label: actionLabel })
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = await readJsonSafe<{ operationId?: string; details?: string; error?: string }>(response)
      if (!response.ok) throw new Error(result?.details ?? result?.error ?? `Yêu cầu thất bại (mã ${response.status})`)
      if (!result?.operationId || typeof result.operationId !== 'string') {
        if (process.env.NODE_ENV !== 'production') {
          // eslint-disable-next-line no-console
          console.error('[operation] response missing operationId — Deploy Agent may be running an outdated build without async operation support', {
            url, httpStatus: response.status, body: result,
          })
        }
        throw new Error('Deploy Agent chưa hỗ trợ theo dõi log realtime (thiếu operationId trong response). Cần cập nhật Deploy Agent lên phiên bản mới nhất.')
      }
      const operation: ActiveOperation = {
        operationId: result.operationId,
        environment: environment.code,
        service: service.code,
        serviceLabel: service.displayName || service.code,
        action,
        actionLabel,
        failVerb: overrides?.failVerb,
      }
      setOperationLogs([])
      setOperationStatus('running')
      setOperationError(undefined)
      setConnectionState('connected')
      setTrackedOperation(operation)
      setActiveOperation(operation)
    } catch (caught) {
      await SwalAlert.error(caught instanceof Error ? caught.message : 'Thao tác thất bại')
      setBusy(null)
    }
  }

  async function deploy(environment: EnvironmentDashboard, service: ServiceStatus) {
    const serviceLabel = service.displayName || service.code
    const digest = await SwalAlert.prompt({
      title: 'Nhập image digest',
      message: `Digest cho ${escapeHtml(serviceLabel)} tại ${escapeHtml(environment.name)}`,
      placeholder: 'sha256:...',
      defaultValue: service.repoDigest ?? 'sha256:',
      confirmText: 'Tiếp tục',
      validator: (value) => {
        const normalized = value.trim().toLowerCase()
        if (!/^sha256:[a-f0-9]{64}$/.test(normalized)) {
          return 'Digest phải có dạng sha256: và 64 ký tự hex.'
        }
        return null
      },
    })
    if (!digest) return
    const normalized = digest.trim().toLowerCase()

    const confirmed = await SwalAlert.confirm({
      title: 'Xác nhận triển khai',
      message: `Bạn có chắc muốn triển khai ${escapeHtml(serviceLabel)} trên môi trường ${escapeHtml(environment.code)}?`,
      confirmText: 'Triển khai',
      cancelText: 'Hủy',
    })
    if (!confirmed) return

    await startOperation(
      `deploy:${environment.code}:${service.code}`,
      '/api/deploy',
      { environment: environment.code, service: service.code, digest: normalized },
      environment, service, 'deploy',
    )
  }

  async function promote(environment: EnvironmentDashboard, service: ServiceStatus) {
    if (!dashboard) return
    const index = dashboard.environments.findIndex((item) => item.code === environment.code)
    const target = dashboard.environments[index + 1]
    if (!target) return
    if (!service.repoDigest) {
      await SwalAlert.error('Service nguồn chưa đọc được digest bất biến.')
      return
    }
    const serviceLabel = service.displayName || service.code
    const confirmed = await SwalAlert.confirm({
      title: 'Xác nhận chuyển tiếp',
      message: `${escapeHtml(serviceLabel)} sẽ được chuyển tiếp từ ${escapeHtml(environment.code)} sang ${escapeHtml(target.code)}.`,
      confirmText: 'Chuyển tiếp',
      cancelText: 'Hủy',
    })
    if (!confirmed) return
    // The operation actually runs on the target agent (promote internally
    // triggers a deploy there), so the SSE stream must target `target`, not
    // the source environment the button lives on.
    await startOperation(
      `promote:${environment.code}:${service.code}`,
      '/api/promote',
      { sourceEnvironment: environment.code, targetEnvironment: target.code, service: service.code },
      target, service, 'deploy',
      { actionLabel: 'Chuyển tiếp', failVerb: 'chuyển tiếp' },
    )
  }

  async function restart(environment: EnvironmentDashboard, service: ServiceStatus) {
    const serviceLabel = service.displayName || service.code
    const confirmed = await SwalAlert.confirm({
      title: 'Xác nhận khởi động lại',
      message: `Dịch vụ ${escapeHtml(serviceLabel)} sẽ được khởi động lại. Bạn có muốn tiếp tục?`,
      confirmText: 'Khởi động lại',
      cancelText: 'Hủy',
    })
    if (!confirmed) return
    await startOperation(
      `restart:${environment.code}:${service.code}`,
      '/api/restart',
      { environment: environment.code, service: service.code },
      environment, service, 'restart',
    )
  }

  async function rollback(environment: EnvironmentDashboard, service: ServiceStatus) {
    const serviceLabel = service.displayName || service.code
    const details = [
      `<div class="mt-3 space-y-1 text-left text-xs">`,
      `<div><span class="text-slate-500">Service:</span> <span class="font-mono">${escapeHtml(service.code)}</span></div>`,
      `<div><span class="text-slate-500">Environment:</span> <span class="font-mono">${escapeHtml(environment.code)}</span></div>`,
      service.repoDigest
        ? `<div><span class="text-slate-500">Digest hiện tại:</span> <span class="font-mono break-all">${escapeHtml(service.repoDigest)}</span></div>`
        : '',
      `</div>`,
    ].join('')
    const confirmed = await SwalAlert.confirm({
      title: 'Xác nhận quay lại phiên bản',
      message: `${escapeHtml(serviceLabel)} sẽ được quay lại phiên bản trước trên ${escapeHtml(environment.code)}.${details}`,
      confirmText: 'Quay lại phiên bản',
      cancelText: 'Hủy',
      danger: true,
    })
    if (!confirmed) return
    await startOperation(
      `rollback:${environment.code}:${service.code}`,
      '/api/rollback',
      { environment: environment.code, service: service.code },
      environment, service, 'rollback',
    )
  }

  async function viewLogs(environment: EnvironmentDashboard, service: ServiceStatus) {
    setBusy({ key: `logs:${environment.code}:${service.code}`, label: 'Đang tải nhật ký' })
    try {
      const response = await fetch(`/api/logs?environment=${encodeURIComponent(environment.code)}&service=${encodeURIComponent(service.code)}&tail=500`)
      const result = await readJsonSafe<{ logs?: string; details?: string; error?: string }>(response)
      if (!response.ok) throw new Error(result?.details ?? result?.error ?? 'Không tải được nhật ký')
      setLogs({ title: `${environment.code} / ${service.code}`, content: result?.logs ?? '' })
    } catch (caught) {
      await SwalAlert.error(caught instanceof Error ? caught.message : 'Không tải được nhật ký')
    } finally {
      setBusy(null)
    }
  }

  function openBuildDialog(environment: EnvironmentDashboard, service: ServiceStatus) {
    setBuildDialogTarget({ environment, service })
  }

  async function submitBuild(tag: string) {
    if (!buildDialogTarget) return
    const githubService = githubServiceForAgentCode(buildDialogTarget.service.code)
    if (!githubService) return
    try {
      await triggerBuild(githubService, { branch: dashboard?.buildBranch ?? 'developer', tag })
      SwalAlert.toast(`Đã gửi yêu cầu build ${githubService}`)
    } catch (caught) {
      await SwalAlert.error(caught instanceof Error ? caught.message : `Không thể gửi yêu cầu build ${githubService}`)
    } finally {
      setBuildDialogTarget(null)
    }
  }

  function openBuildDetail(service: ServiceStatus) {
    const githubService = githubServiceForAgentCode(service.code)
    if (!githubService) return
    setBuildDetailTarget({ githubService, serviceLabel: service.displayName || service.code })
  }

  // Re-reads the build's current status straight from GitHub — e.g. after
  // the user hit "Re-run failed jobs" on GitHub itself. Never dispatches a
  // new workflow run.
  function syncBuildStatus(service: ServiceStatus) {
    const githubService = githubServiceForAgentCode(service.code)
    if (!githubService) return
    syncBuild(githubService)
  }

  const getBuildStateForService = useCallback(
    (service: ServiceStatus) => {
      const githubService = githubServiceForAgentCode(service.code)
      return githubService ? getBuildState(githubService) : undefined
    },
    [getBuildState],
  )

  const environments = dashboard?.environments ?? []
  const agentsOnlineCount = environments.filter((item) => item.online).length
  const healthyServicesCount = environments
    .flatMap((item) => item.services)
    .filter((item) => item.status === 'running' && (item.health === 'healthy' || item.health === 'none')).length
  const lastUpdatedLabel = dashboard ? new Date(dashboard.generatedAt).toLocaleTimeString('vi-VN') : '--'
  const lastUpdatedFull = dashboard ? new Date(dashboard.generatedAt).toLocaleString('vi-VN') : '--'

  const activeIndex = environments.findIndex((item) => item.code === activeEnvironmentCode)
  const activeEnvironment = activeIndex >= 0 ? environments[activeIndex] : undefined
  const nextEnvironment = activeIndex >= 0 ? environments[activeIndex + 1] : undefined
  const previousEnvironment = activeIndex > 0 ? environments[activeIndex - 1] : undefined

  const buildDetailState = buildDetailTarget ? getBuildState(buildDetailTarget.githubService) : undefined

  return (
    <main className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">
      <DashboardHeader
        applicationName={dashboard?.applicationName}
        username={username}
        loading={loading}
        onRefresh={() => void refresh()}
      />

      {error ? (
        <div className="mb-4 rounded border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-300">
          {error}
        </div>
      ) : null}

      {busy ? (
        <button
          type="button"
          onClick={() => trackedOperation && setActiveOperation(trackedOperation)}
          disabled={!trackedOperation}
          className="fixed top-4 left-1/2 z-20 -translate-x-1/2 rounded border border-slate-800 bg-slate-900 px-4 py-2.5 text-sm text-slate-300 disabled:cursor-default"
        >
          {busy.label}…{trackedOperation ? ' · xem log' : ''}
        </button>
      ) : null}

      <SummaryCards
        environmentsCount={environments.length}
        agentsOnlineCount={agentsOnlineCount}
        healthyServicesCount={healthyServicesCount}
        lastUpdatedLabel={lastUpdatedLabel}
      />

      {environments.length > 0 ? (
        <EnvironmentTabs
          environments={environments}
          activeEnvironment={activeEnvironmentCode}
          onChange={handleEnvironmentChange}
        />
      ) : null}

      <section className="w-full">
        {activeEnvironment ? (
          <EnvironmentPanel
            environment={activeEnvironment}
            nextEnvironment={nextEnvironment}
            previousEnvironment={previousEnvironment}
            lastUpdatedAt={lastUpdatedFull}
            busyKey={busy?.key ?? ''}
            getBuildState={getBuildStateForService}
            onDeploy={deploy}
            onPromote={promote}
            onRestart={restart}
            onRollback={rollback}
            onLogs={viewLogs}
            onBuild={openBuildDialog}
            onViewBuild={openBuildDetail}
            onSyncBuild={syncBuildStatus}
            onRetry={() => void refresh(true)}
          />
        ) : !dashboard && loading ? (
          <div className="rounded border border-dashed border-slate-800 p-8 text-center text-sm text-slate-500">
            Đang kết nối các agent…
          </div>
        ) : null}
      </section>

      <AuditLogPanel
        records={audit}
        activeEnvironmentCode={activeEnvironmentCode}
        filter={auditFilter}
        onFilterChange={setAuditFilter}
        storageNotConfigured={auditStorageNotConfigured}
      />

      {logs ? <LogsModal title={logs.title} content={logs.content} onClose={() => setLogs(null)} /> : null}

      {activeOperation ? (
        <OperationLogDrawer
          operation={activeOperation}
          logs={operationLogs}
          status={operationStatus}
          error={operationError}
          connectionState={connectionState}
          onClose={() => setActiveOperation(null)}
        />
      ) : null}

      {buildDialogTarget ? (
        <BuildDialog
          serviceLabel={buildDialogTarget.service.displayName || buildDialogTarget.service.code}
          serviceCode={githubServiceForAgentCode(buildDialogTarget.service.code) ?? buildDialogTarget.service.code}
          branch={dashboard?.buildBranch ?? 'developer'}
          onCancel={() => setBuildDialogTarget(null)}
          onSubmit={submitBuild}
        />
      ) : null}

      {buildDetailTarget && buildDetailState?.runId ? (
        <BuildDetailDrawer
          serviceLabel={buildDetailTarget.serviceLabel}
          runId={buildDetailState.runId}
          runAttempt={buildDetailState.runAttempt}
          htmlUrl={buildDetailState.htmlUrl}
          status={buildDetailState.status}
          onClose={() => setBuildDetailTarget(null)}
        />
      ) : null}
    </main>
  )
}
