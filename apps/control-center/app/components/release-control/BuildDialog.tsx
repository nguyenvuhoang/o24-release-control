'use client'

import { useState } from 'react'

type BuildDialogProps = {
  serviceLabel: string
  serviceCode: string
  branch: string
  onCancel: () => void
  onSubmit: (tag: string) => Promise<void>
}

export function BuildDialog({ serviceLabel, serviceCode, branch, onCancel, onSubmit }: BuildDialogProps) {
  const [tag, setTag] = useState('latest')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit() {
    if (submitting) return
    setSubmitting(true)
    try {
      await onSubmit(tag.trim() || 'latest')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/75 p-6" onClick={submitting ? undefined : onCancel}>
      <section
        className="w-full max-w-md rounded-lg border border-slate-800 bg-slate-950 p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="mb-0.5 text-[11px] tracking-wide text-slate-500">BUILD DOCKER IMAGE</p>
        <h2 className="mb-4 text-base font-semibold text-slate-100">Build {serviceLabel}</h2>

        <div className="space-y-3.5">
          <div>
            <label className="mb-1 block text-[11px] tracking-wide text-slate-500 uppercase">Service</label>
            <div className="rounded border border-slate-800 bg-slate-900/60 px-3 py-2 font-mono text-sm text-slate-300">{serviceCode}</div>
          </div>
          <div>
            <label className="mb-1 block text-[11px] tracking-wide text-slate-500 uppercase">Branch</label>
            <div className="rounded border border-slate-800 bg-slate-900/60 px-3 py-2 font-mono text-sm text-slate-300">{branch}</div>
          </div>
          <div>
            <label htmlFor="build-tag" className="mb-1 block text-[11px] tracking-wide text-slate-500 uppercase">
              Docker Tag
            </label>
            <input
              id="build-tag"
              type="text"
              value={tag}
              disabled={submitting}
              onChange={(event) => setTag(event.target.value)}
              className="w-full rounded border border-slate-800 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 outline-none focus-visible:border-emerald-600 disabled:opacity-60"
              placeholder="latest"
            />
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2.5">
          <button
            type="button"
            disabled={submitting}
            onClick={onCancel}
            className="min-h-[34px] rounded border border-slate-800 bg-transparent px-4 text-sm font-medium text-slate-300 transition-colors duration-150 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-500"
          >
            Hủy
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void handleSubmit()}
            className="min-h-[34px] rounded bg-emerald-600 px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
          >
            {submitting ? 'Đang gửi…' : 'Build Image'}
          </button>
        </div>
      </section>
    </div>
  )
}
