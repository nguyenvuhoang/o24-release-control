import { kvCommand, resolveKvConfig } from './kv'

// User store for the multi-user auth migration (Chat 06 hardening) —
// deliberately Redis-ONLY, unlike auditRepository.ts/releaseRepository.ts's
// KV -> file -> memory tiers. A non-admin user is only ever created by the
// CLI seed script (scripts/seed-users.mjs), which itself refuses to run
// without Redis configured — there is no legitimate scenario where a
// non-admin user should exist without Redis, so a silent file/memory
// fallback here would just hide a misconfiguration. The env-based
// ADMIN_USERNAME/ADMIN_PASSWORD login path (lib/auth.ts) is completely
// independent of this and keeps working with zero Redis dependency.

export type UserRole = 'admin' | 'user'

export type UserRecord = {
  username: string
  passwordHash: string
  role: UserRole
  mustChangePassword: boolean
  createdAt: string
  createdBy: string
}

export type CreateUserInput = {
  username: string
  passwordHash: string
  role: UserRole
  mustChangePassword: boolean
  createdBy: string
}

export interface UserRepository {
  getByUsername(username: string): Promise<UserRecord | undefined>
  /** Never overwrites an existing user — returns { created: false, record: <existing> } instead. */
  createIfAbsent(input: CreateUserInput): Promise<{ record: UserRecord; created: boolean }>
  /**
   * Overwrites the password hash and clears mustChangePassword for an
   * existing user — the one intentional exception to this repository's
   * otherwise never-overwrite stance, used only by the change-password flow.
   * Returns undefined if the user doesn't exist (never creates one here).
   */
  updatePassword(username: string, newPasswordHash: string): Promise<UserRecord | undefined>
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase()
}

function userKey(username: string): string {
  return `o24:user:record:${normalizeUsername(username)}`
}

export class KvUserRepository implements UserRepository {
  constructor(private readonly config: NonNullable<ReturnType<typeof resolveKvConfig>>) {}

  async getByUsername(username: string): Promise<UserRecord | undefined> {
    const raw = await kvCommand(this.config, ['GET', userKey(username)])
    return typeof raw === 'string' ? (JSON.parse(raw) as UserRecord) : undefined
  }

  async createIfAbsent(input: CreateUserInput): Promise<{ record: UserRecord; created: boolean }> {
    const record: UserRecord = {
      username: normalizeUsername(input.username),
      passwordHash: input.passwordHash,
      role: input.role,
      mustChangePassword: input.mustChangePassword,
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy,
    }
    const key = userKey(input.username)
    // SET ... NX is the atomic "never overwrite an existing user" guarantee
    // — same idempotency pattern as auditRepository.ts/releaseRepository.ts.
    const setResult = await kvCommand(this.config, ['SET', key, JSON.stringify(record), 'NX'])
    if (setResult !== 'OK') {
      const existingRaw = await kvCommand(this.config, ['GET', key])
      const existing = typeof existingRaw === 'string' ? (JSON.parse(existingRaw) as UserRecord) : record
      return { record: existing, created: false }
    }
    return { record, created: true }
  }

  async updatePassword(username: string, newPasswordHash: string): Promise<UserRecord | undefined> {
    const key = userKey(username)
    const existingRaw = await kvCommand(this.config, ['GET', key])
    if (typeof existingRaw !== 'string') return undefined
    const existing = JSON.parse(existingRaw) as UserRecord
    const updated: UserRecord = { ...existing, passwordHash: newPasswordHash, mustChangePassword: false }
    await kvCommand(this.config, ['SET', key, JSON.stringify(updated)])
    return updated
  }
}

/** Returns null when Redis isn't configured — callers must treat that as "no non-admin user can be found or created", never throw. */
export function getUserRepository(): UserRepository | null {
  const kvConfig = resolveKvConfig()
  if (!kvConfig) return null
  return new KvUserRepository(kvConfig)
}
