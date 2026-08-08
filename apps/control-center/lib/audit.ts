import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { getDataPath } from './config'
import type { AuditRecord } from './types'

export async function appendAudit(record: Omit<AuditRecord, 'id' | 'timestamp'>): Promise<AuditRecord> {
  const completed: AuditRecord = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...record,
  }
  const filePath = getDataPath('audit.jsonl')
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.appendFile(filePath, `${JSON.stringify(completed)}\n`, { encoding: 'utf8', mode: 0o640 })
  return completed
}

export async function readAudit(limit = 50): Promise<AuditRecord[]> {
  const filePath = getDataPath('audit.jsonl')
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return raw
      .split('\n')
      .filter(Boolean)
      .slice(-Math.min(Math.max(limit, 1), 500))
      .reverse()
      .map((line) => JSON.parse(line) as AuditRecord)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
