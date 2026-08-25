import type { BuildServiceCode } from './github/serviceMap'
import type { ReleaseComparison, ReleaseComparisonState, ReleaseSnapshot, ResolvedRelease, RunningRelease, ServiceStatus } from './types'

/**
 * Pure comparison logic for "Latest Build vs DEV vs UAT vs PROD" — the ONLY
 * place this decision is made. Components must call resolveReleaseComparison
 * and render its result; they must never re-derive "is X in sync with Y"
 * from raw digests themselves (that's exactly how the same comparison ends
 * up implemented three slightly-different ways across a UI).
 *
 * Everything here compares repoDigest only — never a tag, never a build
 * timestamp, never Docker's local imageId. "Which environment is newer" is
 * never inferred from time alone: if a running digest can't be resolved to
 * a known ReleaseSnapshot, this reports that honestly (UNTRACKED_BUILD /
 * UAT_AHEAD_OR_UNKNOWN) instead of guessing an order.
 */

const DIGEST_PATTERN = /sha256:[a-f0-9]{64}/i

/** Extracts "sha256:<hex>" (lowercased) from either a bare or full "repo@sha256:<hex>" reference. */
export function normalizeDigest(value?: string | null): string | undefined {
  if (!value) return undefined
  const match = value.match(DIGEST_PATTERN)
  return match ? match[0].toLowerCase() : undefined
}

function containerStatusOf(rawStatus: string): RunningRelease['containerStatus'] {
  const value = rawStatus.trim().toLowerCase()
  if (!value) return 'missing'
  if (value === 'running') return 'running'
  if (value === 'exited' || value === 'stopped' || value === 'dead') return 'stopped'
  // starting / restarting / paused / created / anything else GitHub-agent
  // might report: real, but not confidently "running" or "stopped".
  return 'unknown'
}

/**
 * Builds one environment's RunningRelease from what the dashboard already
 * has: the live ServiceStatus from that environment's Deploy Agent (never
 * re-fetched here — see useReleaseComparison.ts), plus whichever
 * ReleaseSnapshot (if any) matches its repoDigest. `environmentOnline`
 * false means the agent itself couldn't be reached at all — a completely
 * different situation from "reachable, but this service just isn't
 * deployed there" (serviceStatus undefined while online).
 */
export function toRunningRelease(input: {
  environment: string
  service: BuildServiceCode
  environmentOnline: boolean
  environmentError?: string
  serviceStatus?: ServiceStatus
  matchedSnapshot?: ReleaseSnapshot | null
  checkedAt: string
}): RunningRelease {
  const { environment, service, environmentOnline, environmentError, serviceStatus, matchedSnapshot, checkedAt } = input

  if (!environmentOnline) {
    return {
      environment,
      service,
      containerStatus: 'unknown',
      checkedAt,
      error: environmentError ?? 'Không thể kết nối Deploy Agent',
    }
  }
  if (!serviceStatus) {
    // Agent reachable, but this service isn't in its managed list — a real
    // "not deployed here" answer, not an error.
    return { environment, service, containerStatus: 'missing', checkedAt }
  }
  if (serviceStatus.error) {
    return { environment, service, containerStatus: 'unknown', checkedAt, error: serviceStatus.error }
  }

  const configuredDigest = normalizeDigest(serviceStatus.configuredImage)
  const runningDigest = normalizeDigest(serviceStatus.repoDigest)
  const configDrift = Boolean(configuredDigest) && Boolean(runningDigest) && configuredDigest !== runningDigest

  return {
    environment,
    service,
    repository: matchedSnapshot?.dockerRepository,
    tag: matchedSnapshot?.tag,
    repoDigest: serviceStatus.repoDigest,
    localImageId: serviceStatus.imageId || undefined,
    imageReference: serviceStatus.imageRef || undefined,
    configDrift,
    snapshotId: matchedSnapshot?.id,
    commitSha: matchedSnapshot?.commitSha ?? undefined,
    commitMessage: matchedSnapshot?.commitMessage ?? undefined,
    containerStatus: containerStatusOf(serviceStatus.status),
    checkedAt,
  }
}

type ComparisonInput = {
  latest?: ResolvedRelease
  dev?: RunningRelease
  uat?: RunningRelease
  prod?: RunningRelease
}

/**
 * The state machine. Priority for the headline `state`:
 *   1. NO_BUILD — Docker Hub has nothing resolvable at all.
 *   2. ENVIRONMENT_UNAVAILABLE — DEV (the immediate deploy target) couldn't
 *      be checked; everything downstream of DEV is unknowable too.
 *   3. UNTRACKED_BUILD — latest has no Release Snapshot yet (source
 *      'unknown'/'github'/'release-control' without a matched snapshot) —
 *      the artifact exists but nothing has imported it.
 *   4/5. DEV differs from latest: NEW_BUILD_AVAILABLE when DEV resolves to
 *      a KNOWN snapshot (a legitimate earlier release — including a
 *      deliberate rollback, see the warning pushed below), DEV_OUTDATED
 *      when DEV's own digest can't be resolved to anything at all.
 *   6. DEV synced with latest — headline drills into UAT, then PROD, using
 *      the same known/unknown distinction (UAT_DIFFERS_FROM_DEV vs
 *      UAT_AHEAD_OR_UNKNOWN).
 *   7. UNKNOWN — safety net (DEV online, but no digest and not classified
 *      above — e.g. a transient partial read).
 *
 * Promote eligibility (canPromoteDevToUat/canPromoteUatToProd) is computed
 * independently of the headline: promoting has never depended on "latest"
 * at all (it always deploys the SOURCE environment's own current digest —
 * see /api/promote), so it stays available even in NO_BUILD/UNTRACKED_BUILD.
 */
export function resolveReleaseComparison(input: ComparisonInput): ReleaseComparison {
  const { latest, dev, uat, prod } = input
  const warnings: string[] = []

  const latestDigest = normalizeDigest(latest?.repoDigest)
  const devDigest = normalizeDigest(dev?.repoDigest)
  const uatDigest = normalizeDigest(uat?.repoDigest)
  const prodDigest = normalizeDigest(prod?.repoDigest)

  const devAvailable = Boolean(dev) && !dev!.error
  const uatAvailable = Boolean(uat) && !uat!.error
  const prodAvailable = Boolean(prod) && !prod!.error

  const canPromoteDevToUat = devAvailable && Boolean(devDigest) && uatAvailable
  const canPromoteUatToProd = uatAvailable && Boolean(uatDigest) && prodAvailable

  if (dev && !devAvailable) warnings.push(`Không thể kiểm tra DEV${dev.error ? `: ${dev.error}` : ''}`)
  if (uat && !uatAvailable) warnings.push(`Không thể kiểm tra UAT${uat.error ? `: ${uat.error}` : ''}`)
  if (prod && !prodAvailable) warnings.push(`Không thể kiểm tra PROD${prod.error ? `: ${prod.error}` : ''}`)

  // Real evidence, not inference: the agent's own record of what it last
  // configured (ServiceStatus.configuredImage) resolves to a different
  // digest than what's actually running. Surfaced ahead of every other
  // warning because it changes what action actually helps — redeploying
  // again is unlikely to fix a container that never picked up the previous
  // deploy's pinned image (see RunningRelease.configDrift).
  if (dev?.configDrift) warnings.push('DEV: container đang chạy khác với image đã cấu hình triển khai gần nhất — kiểm tra docker-compose trên máy chủ, triển khai lại có thể không khắc phục được.')
  if (uat?.configDrift) warnings.push('UAT: container đang chạy khác với image đã cấu hình triển khai gần nhất — kiểm tra docker-compose trên máy chủ, triển khai lại có thể không khắc phục được.')
  if (prod?.configDrift) warnings.push('PROD: container đang chạy khác với image đã cấu hình triển khai gần nhất — kiểm tra docker-compose trên máy chủ, triển khai lại có thể không khắc phục được.')

  if (!latest) {
    return { state: 'NO_BUILD', latest, dev, uat, prod, canImportSnapshot: false, canDeployLatestToDev: false, canPromoteDevToUat, canPromoteUatToProd, warnings }
  }

  const canImportSnapshot = !latest.snapshotId
  if (canImportSnapshot) {
    warnings.push('Latest Build chưa có Release Snapshot — có thể đồng bộ để theo dõi và triển khai.')
  }

  if (!devAvailable) {
    return {
      state: 'ENVIRONMENT_UNAVAILABLE',
      latest, dev, uat, prod,
      canImportSnapshot,
      canDeployLatestToDev: false,
      canPromoteDevToUat, canPromoteUatToProd,
      warnings,
    }
  }

  // UAT-vs-DEV and PROD-vs-UAT relationships are recorded regardless of
  // which one ends up as the headline state.
  if (uatAvailable && devDigest && uatDigest && uatDigest !== devDigest) warnings.push('UAT khác DEV')
  if (prodAvailable && uatDigest && prodDigest && prodDigest !== uatDigest) warnings.push('PROD khác UAT')

  const canDeployLatestToDev = Boolean(latestDigest) && devDigest !== latestDigest

  let state: ReleaseComparisonState

  if (devDigest && devDigest === latestDigest) {
    if (!uatAvailable || !uatDigest) {
      state = 'DEV_SYNCED'
    } else if (uatDigest !== devDigest) {
      state = uat?.snapshotId ? 'UAT_DIFFERS_FROM_DEV' : 'UAT_AHEAD_OR_UNKNOWN'
    } else if (!prodAvailable || !prodDigest) {
      state = 'UAT_SYNCED_WITH_DEV'
    } else if (prodDigest !== uatDigest) {
      state = 'PROD_DIFFERS_FROM_UAT'
    } else {
      state = 'PROD_SYNCED_WITH_UAT'
    }
  } else if (!devDigest) {
    state = devAvailable ? 'UNKNOWN' : 'ENVIRONMENT_UNAVAILABLE'
  } else if (canImportSnapshot) {
    state = 'UNTRACKED_BUILD'
  } else if (dev?.snapshotId) {
    state = 'NEW_BUILD_AVAILABLE'
    if (latest.snapshotId && dev.snapshotId !== latest.snapshotId) {
      warnings.push('DEV đang chạy một release cũ hơn Latest Build (có thể do rollback hoặc chọn thủ công) — vẫn có thể triển khai Latest Build.')
    }
  } else {
    state = 'DEV_OUTDATED'
  }

  return { state, latest, dev, uat, prod, canImportSnapshot, canDeployLatestToDev, canPromoteDevToUat, canPromoteUatToProd, warnings }
}
