'use client'

import { SwalAlert } from '../../../lib/swalAlert'

type CopyableValueProps = {
  value?: string | null
  monospace?: boolean
  truncate?: boolean
  className?: string
}

export function CopyableValue({ value, monospace = true, truncate = true, className = '' }: CopyableValueProps) {
  const display = value && value.length > 0 ? value : '--'
  const canCopy = Boolean(value)

  async function handleCopy() {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      SwalAlert.toast('Đã sao chép')
    } catch {
      SwalAlert.toast('Không thể sao chép', 'error')
    }
  }

  return (
    <div className={`flex min-w-0 items-center gap-1.5 ${className}`}>
      <span
        title={value ?? undefined}
        className={`min-w-0 text-slate-200 ${monospace ? 'font-mono' : ''} ${truncate ? 'truncate' : 'break-words'}`}
      >
        {display}
      </span>
      {canCopy ? (
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 transition-colors duration-150 hover:bg-slate-800 hover:text-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-500"
          aria-label="Copy value"
        >
          Sao chép
        </button>
      ) : null}
    </div>
  )
}
