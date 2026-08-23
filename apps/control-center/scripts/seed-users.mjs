// Manual, one-off user seed for the multi-user auth migration (Chat 06
// hardening). Run with: pnpm seed:users
//
// Deliberately NOT wired into any request path, API route, or cold start —
// creating accounts is a human-initiated, run-once action, never automatic.
// Reuses the exact same lib/userRepository.ts + bcryptjs path production
// login verifies against, so a seeded hash is guaranteed compatible.
import bcrypt from 'bcryptjs'
import { resolveKvConfig } from '../lib/kv.ts'
import { getUserRepository } from '../lib/userRepository.ts'

const BCRYPT_COST = 12

const SEED_USERS = [
  { username: 'linhnq', passwordEnvVar: 'SEED_LINHNQ_PASSWORD' },
  { username: 'hoangnv', passwordEnvVar: 'SEED_HOANGNV_PASSWORD' },
]

function fail(message) {
  console.error(`[seed-users] ${message}`)
  process.exit(1)
}

async function main() {
  if (!resolveKvConfig()) {
    fail(
      'Thiếu cấu hình Redis (KV_REST_API_URL/KV_REST_API_TOKEN hoặc UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN). ' +
        'Script sẽ không chạy nếu không có nơi lưu user.',
    )
  }

  const missingPasswordVars = SEED_USERS.filter((u) => !process.env[u.passwordEnvVar]).map((u) => u.passwordEnvVar)
  if (missingPasswordVars.length > 0) {
    fail(`Thiếu biến môi trường mật khẩu ban đầu: ${missingPasswordVars.join(', ')}. Không seed một phần — dừng lại.`)
  }

  const repository = getUserRepository()
  if (!repository) {
    // Shouldn't happen given the resolveKvConfig() check above, but never
    // proceed on an assumption.
    fail('Không khởi tạo được user repository.')
  }

  for (const { username, passwordEnvVar } of SEED_USERS) {
    const existing = await repository.getByUsername(username)
    if (existing) {
      console.log(`[seed-users] ${username}: đã tồn tại — bỏ qua, không ghi đè.`)
      continue
    }

    const plaintextPassword = process.env[passwordEnvVar]
    const passwordHash = await bcrypt.hash(plaintextPassword, BCRYPT_COST)
    const { created } = await repository.createIfAbsent({
      username,
      passwordHash,
      role: 'user',
      mustChangePassword: true,
      createdBy: 'seed-script',
    })
    // Never log plaintextPassword or passwordHash — only the outcome.
    console.log(`[seed-users] ${username}: ${created ? 'đã tạo (mustChangePassword=true)' : 'đã tồn tại — bỏ qua'}.`)
  }

  console.log('')
  console.log('[seed-users] Hoàn tất. Hãy xoá SEED_LINHNQ_PASSWORD và SEED_HOANGNV_PASSWORD khỏi environment ngay bây giờ.')
}

main().catch((error) => {
  console.error('[seed-users] Lỗi không mong đợi:', error instanceof Error ? error.message : error)
  process.exit(1)
})
