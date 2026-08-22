import type { ReleaseSnapshot } from '../../../lib/types'
import { StatusBadge } from './StatusBadge'

const SOURCE_LABEL: Record<ReleaseSnapshot['source'], string> = {
  'github-actions': 'GitHub Actions',
  'docker-registry': 'Docker Registry Sync',
}

type ReleaseTimelineItemProps = {
  release: ReleaseSnapshot
  runningEnvironments: string[]
  onOpen: (release: ReleaseSnapshot) => void
}

export function ReleaseTimelineItem({ release, runningEnvironments, onOpen }: ReleaseTimelineItemProps) {
  return (
    <button
      type="button"
      onClick={() => onOpen(release)}
      className="flex w-full flex-col gap-2 rounded border border-slate-800/70 bg-slate-950/30 px-3.5 py-3 text-left text-xs transition-colors duration-150 hover:border-slate-700 hover:bg-slate-900/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="font-mono text-sm font-semibold text-slate-100">{release.tag}</span>
        <StatusBadge tone="neutral" label={SOURCE_LABEL[release.source]} />
        {runningEnvironments.map((code) => (
          <StatusBadge key={code} tone="success" label={`ĐANG CHẠY · ${code}`} />
        ))}
        <span className="ml-auto shrink-0 text-slate-500">{formatDate(release.createdAt)}</span>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-slate-400">
        <span>
          Nhánh: <span className="text-slate-300">{release.branch ?? '--'}</span>
        </span>
        <span>
          Commit: <span className="font-mono text-slate-300">{shortSha(release.commitSha)}</span>
        </span>
        <span>
          Người tạo: <span className="text-slate-300">{release.createdBy}</span>
        </span>
      </div>

      {release.commitMessage ? <p className="m-0 truncate text-slate-500">{release.commitMessage}</p> : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-slate-500">
        <span className="truncate font-mono">{release.dockerRepository}</span>
        <span className="truncate font-mono text-slate-400">{shortDigest(release.repoDigest)}</span>
      </div>
    </button>
  )
}

function shortSha(value: string | null): string {
  if (!value) return '--'
  return value.slice(0, 12)
}

function shortDigest(value: string): string {
  return value.length > 28 ? `${value.slice(0, 20)}…${value.slice(-8)}` : value
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '--' : date.toLocaleString('vi-VN')
}
