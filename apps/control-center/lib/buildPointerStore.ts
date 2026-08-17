import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isRunningOnVercel, kvCommand, resolveKvConfig } from './kv'

/**
 * A small, best-effort server-side hint: "the last runId control-center
 * itself dispatched for this service". NOT the source of truth for build
 * state — GitHub's Actions API (via findLatestGithubRunForService) is —
 * this exists purely as a fallback for the one case that scan can't cover:
 * a workflow whose run-name/job names don't happen to embed the service
 * code, for builds control-center dispatched itself (Telegram-triggered or
 * GitHub-UI re-run builds still rely on the GitHub-side scan).
 */

const KV_KEY_PREFIX = 'o24:build:pointer:'
const memoryPointers = new Map<string, number>()

function getPointerFilePath(): string {
  const dataDir = process.env.CONTROL_DATA_DIR ?? '/data'
  return path.join(dataDir, 'build-pointers.json')
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
