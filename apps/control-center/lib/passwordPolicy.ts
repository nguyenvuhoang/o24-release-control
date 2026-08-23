import bcrypt from 'bcryptjs'

const MIN_PASSWORD_LENGTH = 8

export type PasswordValidationResult = { ok: true } | { ok: false; error: string }

/**
 * Pure, synchronous checks for a new password — everything that doesn't
 * need the async bcrypt comparison against the old hash. Kept separate from
 * validateNewPassword so the change-password UI can give instant feedback
 * (e.g. "mismatch" as the user types) without round-tripping through bcrypt.
 */
export function validateNewPasswordShape(newPassword: string, confirmPassword: string, username: string): PasswordValidationResult {
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Mật khẩu mới phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự` }
  }
  if (newPassword !== confirmPassword) {
    return { ok: false, error: 'Xác nhận mật khẩu không khớp' }
  }
  if (newPassword.toLowerCase() === username.trim().toLowerCase()) {
    return { ok: false, error: 'Mật khẩu mới không được trùng với tên đăng nhập' }
  }
  return { ok: true }
}

/**
 * Full server-side validation, including the one check that needs the
 * stored hash: the new password must differ from the current one.
 */
export async function validateNewPassword(
  newPassword: string,
  confirmPassword: string,
  username: string,
  currentPasswordHash: string,
): Promise<PasswordValidationResult> {
  const shapeResult = validateNewPasswordShape(newPassword, confirmPassword, username)
  if (!shapeResult.ok) return shapeResult

  const sameAsOld = await bcrypt.compare(newPassword, currentPasswordHash)
  if (sameAsOld) {
    return { ok: false, error: 'Mật khẩu mới phải khác mật khẩu cũ' }
  }
  return { ok: true }
}
