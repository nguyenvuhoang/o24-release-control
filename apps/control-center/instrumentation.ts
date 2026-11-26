// Runs once per server instance at boot (Next.js instrumentation hook,
// stable since Next 15 — see https://nextjs.org/docs/app/guides/instrumentation).
//
// Why this exists: production Redis Gateway requests (both reads and
// writes, see docs/REDIS_GATEWAY.md's "2026-11-26 Vercel transport
// incident" note) were timing out after the full 15000ms budget with NO
// response ever received — not a slow response, a connection that never
// completes. `REDIS_GATEWAY_URL` (redis-gateway.vknight.io.vn) resolves to
// BOTH an IPv4 (A) and an IPv6 (AAAA) Cloudflare address:
//
//   nslookup redis-gateway.vknight.io.vn
//     2606:4700:3037::ac43:826e   (AAAA, Cloudflare)
//     2606:4700:3035::6815:864    (AAAA, Cloudflare)
//     172.67.130.110              (A, Cloudflare)
//     104.21.8.100                (A, Cloudflare)
//
// Node's `fetch` (undici) does not race IPv4/IPv6 the way a browser's
// Happy-Eyeballs implementation does: it connects to whichever address
// `dns.lookup()` returns first, in the OS/platform's default order
// ('verbatim' — i.e. whatever getaddrinfo() returns, often AAAA-first on a
// dual-stack resolver). If the serverless runtime's outbound network path
// does not actually support IPv6 egress (common on constrained/NAT'd
// serverless networks) and can't deliver a clean "unreachable" signal, that
// single connection attempt hangs until the caller's own timeout fires —
// exactly the symptom observed ("timed out after 15000ms", unconditionally,
// for every op, unaffected by concurrency or timeout-length changes, while
// other clients — a Windows/PowerShell test, a smoke test from a different
// network — succeed). Forcing IPv4 first removes that single-path dead end
// for every outbound Node connection in this app (Redis Gateway, GitHub,
// Docker Hub, Deploy Agent) — none of those other integrations are known to
// need IPv6, so this is a safe, process-wide default.
//
// This does NOT touch TLS behavior (certificate verification, ciphers,
// protocol versions) — only DNS address-family ordering — and is
// independently overridable if it ever needs to be undone without a
// redeploy.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const requested = (process.env.DNS_RESULT_ORDER ?? 'ipv4first').trim()
  if (requested !== 'ipv4first' && requested !== 'verbatim') {
    console.error('[instrumentation] DNS_RESULT_ORDER must be "ipv4first" or "verbatim" — ignoring invalid value', {
      value: requested,
    })
    return
  }

  try {
    // Dynamic import, not a top-level one: Next.js builds this file's
    // register() for both the nodejs and edge runtimes (this app uses
    // neither 'edge' nor middleware, but the instrumentation hook doesn't
    // know that in advance). A top-level `import dns from 'node:dns'` would
    // break the edge bundle outright; this dynamic form only ever actually
    // runs after the NEXT_RUNTIME guard above, so it's a build-time-only
    // warning ("Node.js module ... not supported in the Edge Runtime"),
    // never a runtime failure — expected and safe to ignore.
    const dns = await import('node:dns')
    dns.setDefaultResultOrder(requested as 'ipv4first' | 'verbatim')
  } catch (error) {
    console.error('[instrumentation] failed to set DNS result order', {
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}
