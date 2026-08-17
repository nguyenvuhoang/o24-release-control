import type { ServiceStatus } from './types'

/**
 * Shape of a single item from GET /api/services as actually observed on the
 * wire. Deploy Agent 1.2.1 and earlier used image/imageID/digest/git_revision
 * instead of the current imageRef/imageId/repoDigest/gitRevision contract —
 * this type covers both so an un-upgraded agent's response can still be
 * normalized without TypeScript rejecting the extra/legacy fields.
 */
export type RawServiceStatus = {
  code: string
  displayName: string
  composeService: string
  containerName: string
  status: string
  health: string
  imageRef?: string
  image?: string
  imageId?: string
  imageID?: string
  repoDigest?: string
  digest?: string
  gitRevision?: string
  git_revision?: string
  startedAt?: string
  configuredImage?: string
  error?: string
}

const DIGEST_PATTERN = /sha256:[a-f0-9]{64}/i

/** Pulls a "sha256:<64 hex>" digest out of an image reference such as "repo@sha256:...". */
export function extractDigest(value?: string): string | undefined {
  if (!value) return undefined
  const match = value.match(DIGEST_PATTERN)
  return match ? match[0].toLowerCase() : undefined
}

/**
 * Bridges Deploy Agent's current field names and its legacy (1.2.1 and
 * earlier) field names into the one ServiceStatus contract the UI relies on,
 * so IMAGE / DIGEST / GIT REVISION never silently blank out just because an
 * agent hasn't been upgraded yet. The UI-facing ServiceStatus contract itself
 * is unchanged — this only widens what's accepted coming in.
 */
export function normalizeServiceStatus(raw: RawServiceStatus): ServiceStatus {
  const imageRef = raw.imageRef ?? raw.image ?? raw.configuredImage ?? ''
  const imageId = raw.imageId ?? raw.imageID ?? ''
  const repoDigest =
    raw.repoDigest ?? raw.digest ?? extractDigest(raw.imageRef) ?? extractDigest(raw.image) ?? undefined
  const gitRevision = raw.gitRevision ?? raw.git_revision ?? undefined

  return {
    code: raw.code,
    displayName: raw.displayName,
    composeService: raw.composeService,
    containerName: raw.containerName,
    status: raw.status,
    health: raw.health,
    imageRef,
    imageId,
    repoDigest,
    gitRevision,
    startedAt: raw.startedAt,
    configuredImage: raw.configuredImage,
    error: raw.error,
  }
}
