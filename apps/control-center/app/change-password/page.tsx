import { redirect } from 'next/navigation'
import Image from 'next/image'
import { getSession } from '../../lib/sessionCookies'
import { ChangePasswordForm } from '../components/ChangePasswordForm'

export const dynamic = 'force-dynamic'

// Server-rendered and re-checked on every request — this is what makes the
// "cannot be skipped by hitting the URL directly" requirement actually
// hold: there is no client-side-only guard here that a direct navigation
// could bypass.
export default async function ChangePasswordPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  if (!session.mustChangePassword) redirect('/')

  return (
    <main className="grid min-h-screen place-items-center p-5">
      <section className="w-full max-w-[400px] rounded-xl border border-slate-800 bg-slate-900/80 p-8">
        <Image src="/logo.png" alt="O24" width={40} height={40} priority className="mb-5 h-10 w-10 object-contain" />
        <p className="mb-1.5 text-[11px] font-semibold tracking-[0.1em] text-slate-500">QUẢN LÝ TRIỂN KHAI</p>
        <h1 className="text-2xl font-semibold text-slate-100">Đổi mật khẩu lần đầu</h1>
        <p className="mt-2 text-sm text-slate-500">
          Tài khoản <span className="font-mono text-slate-300">{session.username}</span> cần đặt mật khẩu mới trước khi tiếp tục sử dụng hệ thống.
        </p>
        <ChangePasswordForm />
      </section>
    </main>
  )
}
