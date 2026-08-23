'use client'

import { useState } from 'react'
import { readJsonSafe } from '../../lib/http'

type ChangePasswordResponse = { success: true } | { success: false; error: string; details?: string }

export function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (submitting) return
    setError('')
    setSubmitting(true)
    try {
      const response = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      })
      const data = await readJsonSafe<ChangePasswordResponse>(response)
      if (!response.ok || !data || !data.success) {
        const message = data && !data.success ? (data.details ?? data.error) : `Đổi mật khẩu thất bại (mã ${response.status})`
        setError(message)
        return
      }
      // Full reload so the server re-reads the rotated session cookie —
      // a client-side route push could otherwise render stale server data.
      window.location.href = '/'
    } catch {
      setError('Không thể kết nối tới máy chủ')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="mt-6 grid gap-4">
      {error ? (
        <div className="rounded border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-300">{error}</div>
      ) : null}
      <label className="grid gap-1.5 text-xs font-semibold text-slate-400">
        Mật khẩu hiện tại
        <input
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          autoComplete="current-password"
          required
          disabled={submitting}
          className="min-h-[40px] rounded border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-slate-600 focus:ring-1 focus:ring-slate-600 disabled:opacity-60"
        />
      </label>
      <label className="grid gap-1.5 text-xs font-semibold text-slate-400">
        Mật khẩu mới
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
          minLength={8}
          required
          disabled={submitting}
          className="min-h-[40px] rounded border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-slate-600 focus:ring-1 focus:ring-slate-600 disabled:opacity-60"
        />
      </label>
      <label className="grid gap-1.5 text-xs font-semibold text-slate-400">
        Xác nhận mật khẩu mới
        <input
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
          minLength={8}
          required
          disabled={submitting}
          className="min-h-[40px] rounded border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-slate-600 focus:ring-1 focus:ring-slate-600 disabled:opacity-60"
        />
      </label>
      <button
        type="submit"
        disabled={submitting}
        className="min-h-[40px] w-full rounded bg-emerald-600 text-sm font-medium text-white transition-colors duration-150 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
      >
        {submitting ? 'Đang đổi mật khẩu…' : 'Đổi mật khẩu'}
      </button>
    </form>
  )
}
