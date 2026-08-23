import { NextResponse } from 'next/server'
import { handleReconcileSnapshotsCron } from '../../../../lib/snapshotReconciliationCron'

// Vercel Cron invokes scheduled routes with GET and an
// `Authorization: Bearer ${CRON_SECRET}` header when CRON_SECRET is set as
// a project env var and this route is declared in vercel.json — see
// vercel.json at the repo root. Also callable manually/by another
// scheduler with the same header. All real logic lives in
// snapshotReconciliationCron.ts (kept free of 'next/server' so it stays
// unit-testable).
export async function GET(request: Request) {
  const result = await handleReconcileSnapshotsCron(request.headers.get('authorization'))
  return NextResponse.json(result.body, { status: result.status })
}
