import { NextResponse } from 'next/server'
import { handleGithubWorkflowRunWebhook } from '../../../../lib/github/webhookHandler'

// Thin Next.js wrapper — all real logic lives in webhookHandler.ts (which
// deliberately avoids importing 'next/server' so it stays unit-testable).
export async function POST(request: Request) {
  const rawBody = await request.text()
  const result = await handleGithubWorkflowRunWebhook(rawBody, {
    signature: request.headers.get('x-hub-signature-256'),
    event: request.headers.get('x-github-event'),
  })
  return NextResponse.json(result.body, { status: result.status })
}
