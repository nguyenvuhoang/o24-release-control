import Image from 'next/image'
import { redirect } from 'next/navigation'
import { getSession } from '../../lib/sessionCookies'

export const dynamic = 'force-dynamic'

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await getSession()
  if (session) redirect(session.mustChangePassword ? '/change-password' : '/')
  const params = await searchParams

  return (
    <main className="grid min-h-screen place-items-center p-5">
      <section className="w-full max-w-[400px] rounded-xl border border-slate-800 bg-slate-900/80 p-8">
        <Image src="/logo.png" alt="O24" width={40} height={40} priority className="mb-5 h-10 w-10 object-contain" />
        <p className="mb-1.5 text-[11px] font-semibold tracking-[0.1em] text-slate-500">QUẢN LÝ TRIỂN KHAI</p>
        <h1 className="text-2xl font-semibold text-slate-100">Đăng nhập quản trị</h1>
        <p className="mt-2 text-sm text-slate-500">Quản lý triển khai DEV → UAT → PROD tại một nơi.</p>
        {params.error ? (
          <div className="mt-4 rounded border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-300">
            Tên đăng nhập hoặc mật khẩu không đúng.
          </div>
        ) : null}
        <form action="/api/auth/login" method="post" className="mt-6 grid gap-4">
          <label className="grid gap-1.5 text-xs font-semibold text-slate-400">
            Tên đăng nhập
            <input
              name="username"
              autoComplete="username"
              required
              className="min-h-[40px] rounded border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-slate-600 focus:ring-1 focus:ring-slate-600"
            />
          </label>
          <label className="grid gap-1.5 text-xs font-semibold text-slate-400">
            Mật khẩu
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="min-h-[40px] rounded border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-slate-600 focus:ring-1 focus:ring-slate-600"
            />
          </label>
          <button
            type="submit"
            className="min-h-[40px] w-full rounded bg-emerald-600 text-sm font-medium text-white transition-colors duration-150 hover:bg-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
          >
            Đăng nhập
          </button>
        </form>
      </section>
    </main>
  )
}
