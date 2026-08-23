'use client'

import { useCallback, useState } from 'react'
import { readJsonSafe } from '../../../lib/http'
import type { AffectedServicesResponse, AffectedServicesError } from '../../../lib/types'
import type { BuildServiceCode } from '../../../lib/github/serviceMap'
import { BUILD_SERVICES } from '../../../lib/github/serviceMap'

export type AffectedServicesPreviewState = {
  loading: boolean
  error?: string
  result?: AffectedServicesResponse
  selected: Set<BuildServiceCode>
}

// Drives POST /api/builds/affected-services and the selection checkboxes
// that follow it — kept separate from the panel component so the panel
// stays presentational. Selection always resets to exactly the resolver's
// affectedServices whenever a new preview comes back (never carries over a
// previous preview's selection).
export function useAffectedServicesPreview() {
  const [state, setState] = useState<AffectedServicesPreviewState>({ loading: false, selected: new Set() })

  const runPreview = useCallback(async (base: string, head: string) => {
    setState((prev) => ({ ...prev, loading: true, error: undefined }))
    try {
      const response = await fetch('/api/builds/affected-services', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base, head }),
      })
      const data = await readJsonSafe<AffectedServicesResponse | AffectedServicesError>(response)
      if (!response.ok || !data || !data.success) {
        const message = data && !data.success ? (data.details ?? data.error) : undefined
        throw new Error(message ?? `Không kiểm tra được service bị ảnh hưởng (mã ${response.status})`)
      }
      setState({ loading: false, result: data, selected: new Set(data.affectedServices) })
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Không kiểm tra được service bị ảnh hưởng'
      setState((prev) => ({ ...prev, loading: false, error: message }))
    }
  }, [])

  const toggleService = useCallback((service: BuildServiceCode) => {
    setState((prev) => {
      const next = new Set(prev.selected)
      if (next.has(service)) next.delete(service)
      else next.add(service)
      return { ...prev, selected: next }
    })
  }, [])

  const reset = useCallback(() => {
    setState({ loading: false, selected: new Set() })
  }, [])

  return { state, runPreview, toggleService, reset, BUILD_SERVICES }
}
