type LogsModalProps = {
  title: string
  content: string
  onClose: () => void
}

export function LogsModal({ title, content, onClose }: LogsModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-950/75 p-6"
      onClick={onClose}
    >
      <section
        className="flex max-h-[88vh] w-full max-w-5xl flex-col rounded-lg border border-slate-800 bg-slate-950 p-4"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-4">
          <div>
            <p className="mb-0.5 text-[11px] tracking-wide text-slate-500">NHẬT KÝ CONTAINER</p>
            <h2 className="text-base font-semibold text-slate-100">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[32px] rounded border border-slate-800 bg-transparent px-3 text-xs font-medium text-slate-300 transition-colors duration-150 hover:bg-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
          >
            Đóng
          </button>
        </div>
        <pre className="m-0 overflow-auto rounded border border-slate-800 bg-black/30 p-3.5 text-xs leading-relaxed whitespace-pre-wrap break-words text-slate-400">
          {content || 'Không có nhật ký.'}
        </pre>
      </section>
    </div>
  )
}
