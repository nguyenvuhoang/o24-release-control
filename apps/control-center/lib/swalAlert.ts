'use client'

import Swal from 'sweetalert2'

// Central place for all user-facing dialogs/toasts. Nothing in the app
// should call window.alert/confirm/prompt directly — use this wrapper so
// every confirmation and every success/error message shares one look.

const POPUP_CLASS = 'rounded-lg border border-slate-800 shadow-2xl shadow-black/50 font-sans'
const TITLE_CLASS = 'text-lg font-semibold text-slate-100 font-sans'
const TEXT_CLASS = 'text-sm text-slate-400 font-sans'

const PRIMARY_BUTTON = 'min-h-[36px] rounded bg-emerald-600 px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600'
const DANGER_BUTTON = 'min-h-[36px] rounded bg-rose-600 px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-rose-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-rose-600'
const NEUTRAL_BUTTON = 'min-h-[36px] rounded border border-slate-800 bg-transparent px-4 text-sm font-medium text-slate-300 transition-colors duration-150 hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-500'

const base = Swal.mixin({
  background: '#0f172b', // slate-900
  color: '#f1f5f9', // slate-100
  buttonsStyling: false,
  reverseButtons: true,
  customClass: {
    popup: POPUP_CLASS,
    title: TITLE_CLASS,
    htmlContainer: TEXT_CLASS,
    confirmButton: PRIMARY_BUTTON,
    cancelButton: NEUTRAL_BUTTON,
  },
})

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

type ConfirmOptions = {
  title: string
  message: string
  confirmText: string
  cancelText?: string
  danger?: boolean
}

type PromptOptions = {
  title: string
  message?: string
  placeholder?: string
  defaultValue?: string
  confirmText?: string
  cancelText?: string
  validator?: (value: string) => string | null
}

export const SwalAlert = {
  async confirm(options: ConfirmOptions): Promise<boolean> {
    const result = await base.fire({
      icon: options.danger ? 'warning' : undefined,
      iconColor: options.danger ? '#ff2357' : undefined,
      title: options.title,
      html: options.message,
      showCancelButton: true,
      confirmButtonText: options.confirmText,
      cancelButtonText: options.cancelText ?? 'Hủy',
      customClass: {
        popup: POPUP_CLASS,
        title: TITLE_CLASS,
        htmlContainer: TEXT_CLASS,
        confirmButton: options.danger ? DANGER_BUTTON : PRIMARY_BUTTON,
        cancelButton: NEUTRAL_BUTTON,
      },
    })
    return result.isConfirmed
  },

  async prompt(options: PromptOptions): Promise<string | null> {
    const result = await base.fire({
      title: options.title,
      html: options.message,
      input: 'text',
      inputPlaceholder: options.placeholder,
      inputValue: options.defaultValue ?? '',
      showCancelButton: true,
      confirmButtonText: options.confirmText ?? 'Xác nhận',
      cancelButtonText: options.cancelText ?? 'Hủy',
      inputValidator: (value: string) => {
        const message = options.validator?.(value ?? '')
        return message ?? undefined
      },
    })
    if (!result.isConfirmed) return null
    return typeof result.value === 'string' ? result.value : String(result.value ?? '')
  },

  success(message: string, title = 'Thành công'): Promise<unknown> {
    return base.fire({
      icon: 'success',
      iconColor: '#00bb7f',
      title,
      text: message,
      confirmButtonText: 'Đóng',
    })
  },

  error(message: string, options?: { title?: string; detail?: string }): Promise<unknown> {
    const detailBlock = options?.detail
      ? `<pre class="mt-3 max-h-40 overflow-auto rounded border border-slate-800 bg-black/30 p-2 text-left text-xs whitespace-pre-wrap break-words text-rose-300">${escapeHtml(options.detail)}</pre>`
      : ''
    return base.fire({
      icon: 'error',
      iconColor: '#ff2357',
      title: options?.title ?? 'Thao tác thất bại',
      html: `<p>${escapeHtml(message)}</p>${detailBlock}`,
      confirmButtonText: 'Đóng',
    })
  },

  toast(message: string, icon: 'success' | 'error' = 'success'): void {
    void base.fire({
      toast: true,
      position: 'top-end',
      timer: 1500,
      showConfirmButton: false,
      icon,
      iconColor: icon === 'success' ? '#00bb7f' : '#ff2357',
      title: message,
      customClass: {
        popup: 'rounded-lg border border-slate-800 shadow-xl shadow-black/40 font-sans',
        title: 'text-sm text-slate-100 font-sans',
      },
    })
  },

  loading(title: string): void {
    void base.fire({
      title,
      allowOutsideClick: false,
      allowEscapeKey: false,
      showConfirmButton: false,
      didOpen: () => Swal.showLoading(),
    })
  },

  close(): void {
    Swal.close()
  },
}
