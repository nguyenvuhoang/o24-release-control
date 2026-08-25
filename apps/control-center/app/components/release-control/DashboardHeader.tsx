import Image from 'next/image'

type DashboardHeaderProps = {
  applicationName?: string
  username: string
  loading: boolean
  onRefresh: () => void
  onCheckAffectedServices: () => void
  onBackfillMetadata: () => void
  backfillingMetadata: boolean
}

export function DashboardHeader({
  applicationName,
  username,
  loading,
  onRefresh,
  onCheckAffectedServices,
  onBackfillMetadata,
  backfillingMetadata,
}: DashboardHeaderProps) {
  return (
    <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="flex items-start gap-3">
        <Image
          src="/logo.png"
          alt="O24"
          width={40}
          height={40}
          priority
          className="h-[30px] w-[30px] shrink-0 object-contain sm:h-9 sm:w-9 lg:h-10 lg:w-10"
        />
        <div>
          <p className="mb-1 text-xs font-semibold tracking-[0.1em] text-slate-500">QUẢN LÝ TRIỂN KHAI</p>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100 lg:text-3xl">
            {applicationName ?? 'Quản lý triển khai IPS'}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Theo dõi và chuyển phiên bản triển khai qua DEV → UAT → PROD.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="rounded border border-slate-800 bg-slate-900/60 px-3 py-1.5 text-sm text-slate-400">
          {username}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="min-h-[34px] rounded border border-slate-800 bg-slate-900/40 px-3.5 text-sm font-medium text-slate-200 transition-colors duration-150 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
        >
          {loading ? 'Đang làm mới…' : 'Làm mới'}
        </button>
        <button
          type="button"
          onClick={onCheckAffectedServices}
          className="min-h-[34px] rounded border border-slate-800 bg-slate-900/40 px-3.5 text-sm font-medium text-slate-200 transition-colors duration-150 hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
        >
          Kiểm tra service bị ảnh hưởng
        </button>
        <button
          type="button"
          onClick={onBackfillMetadata}
          disabled={backfillingMetadata}
          title="Điền commit SHA/commit message còn thiếu cho các Release Snapshot cũ — không tạo release mới, không đổi digest/tag/artifact"
          className="min-h-[34px] rounded border border-slate-800 bg-slate-900/40 px-3.5 text-sm font-medium text-slate-200 transition-colors duration-150 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
        >
          {backfillingMetadata ? 'Đang điền bổ sung…' : 'Điền bổ sung Commit'}
        </button>
        <form action="/api/auth/logout" method="post">
          <button
            type="submit"
            className="min-h-[34px] rounded border border-slate-800 bg-transparent px-3.5 text-sm font-medium text-slate-400 transition-colors duration-150 hover:bg-slate-900 hover:text-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
          >
            Đăng xuất
          </button>
        </form>
      </div>
    </header>
  )
}
