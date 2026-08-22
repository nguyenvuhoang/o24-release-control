import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isRunningOnVercel, kvCommand, resolveKvConfig } from './kv'
import type { BuildIntent } from './types'

/**
 * Build Intent Store: two related, storage-agnostic hint stores that share
 * a backend-selection strategy (KV -> file -> in-memory, same as
 * auditRepository.ts / releaseRepository.ts). Neither is the source of
 * truth for build state — GitHub's Actions API is — they exist purely as
 * best-effort fallbacks/records for cases GitHub's API can't answer itself:
 *
 *  - recordDispatchedRun/getLastDispatchedRun (legacy "build pointer"): "the
 *    last runId control-center itself dispatched for this service" — a
 *    fallback for the one case findLatestGithubRunForService's title-scan
 *    can't cover: a workflow whose run-name/job names don't embed the
 *    service code, for builds control-center dispatched itself
 *    (Telegram-triggered or GitHub-UI re-run builds still rely on the
 *    GitHub-side scan).
 *  - recordBuildIntent/getBuildIntent/getLatestBuildIntent: "who asked for
 *    this build, and what did they ask for" — GitHub's REST API exposes no
 *    workflow_dispatch inputs on a run object (see github/client.ts), so
 *    this is the only place that association is recorded at all.
 */

const KV_KEY_PREFIX = 'o24:build:pointer:'
const KV_INTENT_PREFIX = 'o24:build:intent:'
const KV_LATEST_INTENT_PREFIX = 'o24:build:latest:'
const memoryPointers = new Map<string, number>()
const memoryIntents = new Map<number, BuildIntent>()
const memoryLatestIntents = new Map<string, BuildIntent>()

function getPointerFilePath(): string {
  const dataDir = process.env.CONTROL_DATA_DIR ?? '/data'
  return path.join(dataDir, 'build-pointers.json')
}

function getIntentFilePath(): string {
  const dataDir = process.env.CONTROL_DATA_DIR ?? '/data'
  return path.join(dataDir, 'build-intents.json')
}

async function readPointerFile(filePath: string): Promise<Record<string, number>> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw) as Record<string, number>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

async function readIntentFile(filePath: string): Promise<Record<string, BuildIntent>> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw) as Record<string, BuildIntent>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

export async function recordDispatchedRun(service: string, runId: number): Promise<void> {
  const kvConfig = resolveKvConfig()
  if (kvConfig) {
    await kvCommand(kvConfig, ['SET', KV_KEY_PREFIX + service, String(runId)])
    return
  }
  if (isRunningOnVercel()) {
    memoryPointers.set(service, runId)
    return
  }
  const filePath = getPointerFilePath()
  const all = await readPointerFile(filePath)
  all[service] = runId
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(all), { encoding: 'utf8', mode: 0o640 })
}

export async function getLastDispatchedRun(service: string): Promise<number | undefined> {
  const kvConfig = resolveKvConfig()
  if (kvConfig) {
    const raw = await kvCommand(kvConfig, ['GET', KV_KEY_PREFIX + service])
    return typeof raw === 'string' ? Number(raw) : undefined
  }
  if (isRunningOnVercel()) {
    return memoryPointers.get(service)
  }
  const all = await readPointerFile(getPointerFilePath())
  return all[service]
}

/**
 * Records a Build Intent: "who requested this GitHub run, and what did they
 * ask for". Called once, right after a dispatch succeeds and control-center
 * has a real runId (see /api/builds). Overwrites any prior intent for the
 * same runId (there is no legitimate reason to record one twice) and always
 * updates the per-service "latest" pointer.
 */
export async function recordBuildIntent(intent: BuildIntent): Promise<void> {
  const kvConfig = resolveKvConfig()
  if (kvConfig) {
    const serialized = JSON.stringify(intent)
    await kvCommand(kvConfig, ['SET', KV_INTENT_PREFIX + intent.runId, serialized])
    await kvCommand(kvConfig, ['SET', KV_LATEST_INTENT_PREFIX + intent.service, serialized])
    return
  }
  if (isRunningOnVercel()) {
    memoryIntents.set(intent.runId, intent)
    memoryLatestIntents.set(intent.service, intent)
    return
  }
  const filePath = getIntentFilePath()
  const all = await readIntentFile(filePath)
  all[String(intent.runId)] = intent
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(all), { encoding: 'utf8', mode: 0o640 })
}

export async function getBuildIntent(runId: number): Promise<BuildIntent | undefined> {
  const kvConfig = resolveKvConfig()
  if (kvConfig) {
    const raw = await kvCommand(kvConfig, ['GET', KV_INTENT_PREFIX + runId])
    return typeof raw === 'string' ? (JSON.parse(raw) as BuildIntent) : undefined
  }
  if (isRunningOnVercel()) {
    return memoryIntents.get(runId)
  }
  const all = await readIntentFile(getIntentFilePath())
  return all[String(runId)]
}

export async function getLatestBuildIntent(service: string): Promise<BuildIntent | undefined> {
  const kvConfig = resolveKvConfig()
  if (kvConfig) {
    const raw = await kvCommand(kvConfig, ['GET', KV_LATEST_INTENT_PREFIX + service])
    return typeof raw === 'string' ? (JSON.parse(raw) as BuildIntent) : undefined
  }
  if (isRunningOnVercel()) {
    return memoryLatestIntents.get(service)
  }
  // File backend keeps a single intent-by-runId map (no separate "latest"
  // file) — the scan is fine at self-hosted scale and keeps the on-disk
  // format single-source.
  const all = await readIntentFile(getIntentFilePath())
  return Object.values(all)
    .filter((intent) => intent.service === service)
    .reduce<BuildIntent | undefined>((latest, current) => {
      if (!latest || current.requestedAt > latest.requestedAt) return current
      return latest
    }, undefined)
}
