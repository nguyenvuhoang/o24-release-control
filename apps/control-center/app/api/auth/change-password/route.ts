import { NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { requireApiSession } from '../../../../lib/api'
import { appendAudit } from '../../../../lib/audit'
import { validateNewPassword } from '../../../../lib/passwordPolicy'
import { createSession } from '../../../../lib/sessionCookies'
import { getUserRepository } from '../../../../lib/userRepository'

const BCRYPT_COST = 12

function changePasswordError(error: string, status: number, details?: string) {
  return NextResponse.json({ success: false, error, details }, { status })
}

export async function POST(request: Request) {
  // Exempt from the mustChangePassword gate — this IS the route that clears it.
  const session = await requireApiSession({ allowPasswordChangeRequired: true })
  if (session instanceof NextResponse) return session

  let body: { currentPassword?: string; newPassword?: string; confirmPassword?: string }
  try {
    body = await request.json()
  } catch {
    return changePasswordError('invalid_request_body', 400, 'Request body must be JSON')
  }

  const currentPassword = body.currentPassword ?? ''
  const newPassword = body.newPassword ?? ''
  const confirmPassword = body.confirmPassword ?? ''
  if (!currentPassword || !newPassword || !confirmPassword) {
    return changePasswordError('invalid_request', 400, 'currentPassword, newPassword và confirmPassword đều bắt buộc')
  }

  // The env-based admin account has no Redis user record to rotate — there
  // is no password for this flow to change. Explicit, honest rejection
  // rather than a silent no-op that would look like success.
  if (session.role === 'admin') {
    return changePasswordError('admin_password_not_manageable', 400, 'Tài khoản admin (qua biến môi trường) không hỗ trợ đổi mật khẩu qua giao diện này')
  }

  const userRepository = getUserRepository()
  if (!userRepository) {
    return changePasswordError('user_store_unavailable', 503, 'Không thể kết nối tới nơi lưu tài khoản')
  }

  const record = await userRepository.getByUsername(session.username)
  if (!record) {
    return changePasswordError('user_not_found', 404, 'Không tìm thấy tài khoản')
  }

  const currentPasswordMatches = await bcrypt.compare(currentPassword, record.passwordHash)
  if (!currentPasswordMatches) {
    await appendAudit({
      idempotencyKey: `password-change-failed:${session.username}:${Date.now()}`,
      username: session.username,
      action: 'password-change',
      status: 'failed',
      error: 'current_password_mismatch',
    })
    return changePasswordError('current_password_mismatch', 401, 'Mật khẩu hiện tại không đúng')
  }

  const validation = await validateNewPassword(newPassword, confirmPassword, session.username, record.passwordHash)
  if (!validation.ok) {
    return changePasswordError('invalid_new_password', 400, validation.error)
  }

  const newPasswordHash = await bcrypt.hash(newPassword, BCRYPT_COST)
  const updated = await userRepository.updatePassword(session.username, newPasswordHash)
  if (!updated) {
    return changePasswordError('user_not_found', 404, 'Không tìm thấy tài khoản')
  }

  // Rotate the session so mustChangePassword flips to false immediately —
  // never leave the OLD (still-must-change) cookie in place.
  await createSession({ username: updated.username, role: updated.role, mustChangePassword: false })

  // Audit the event without ever including the password or hash.
  await appendAudit({
    idempotencyKey: `password-change:${session.username}:${Date.now()}`,
    username: session.username,
    action: 'password-change',
    status: 'succeeded',
  })

  return NextResponse.json({ success: true })
}
