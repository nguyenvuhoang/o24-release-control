import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  // RELEASE_PROJECT ('ips' | 'w4s', never a secret) picks the active
  // ProjectProfile in lib/projectProfile.ts, which several CLIENT
  // components read indirectly (ServiceCard.tsx/useReleaseComparison.ts
  // import BUILD_SERVICES/githubServiceForAgentCode from
  // lib/github/serviceMap.ts). Without this, Next only inlines
  // NEXT_PUBLIC_-prefixed vars into the browser bundle, so
  // process.env.RELEASE_PROJECT read there is always undefined — the
  // client-side ACTIVE_PROJECT_PROFILE module constant silently defaults
  // to 'ips' regardless of which deployment this actually is. That
  // defaulted-to-'ips' profile's service list doesn't include W4S/AI, so
  // githubServiceForAgentCode('o24-w4s'/'o24-ai') returns null ONLY in the
  // browser — canBuild/showComparison (ServiceCard.tsx) then hide Build,
  // Latest Build and the version pipeline for exactly those two services,
  // while CTH/NCH/PMT (present in both profiles) keep working by
  // coincidence. Verified live against the real w4s deployment: the W4S
  // card's "⋯" menu had no Build/Sync/Deploy-manually entries at all.
  // `env` (unlike NEXT_PUBLIC_) inlines a SERVER-resolved value into both
  // server and client bundles at build time without renaming the var —
  // exactly this case, since each Vercel project already sets its own
  // RELEASE_PROJECT for its own build.
  env: {
    RELEASE_PROJECT: process.env.RELEASE_PROJECT,
  },
}

export default nextConfig
