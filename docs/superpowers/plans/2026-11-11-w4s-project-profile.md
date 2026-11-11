# W4S Project Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one Release Control codebase safely operate either the existing IPS Control Center or an isolated eight-service W4S Control Center selected by `RELEASE_PROJECT`.

**Architecture:** Add a typed project-profile module as the only source of service catalogs, image namespaces, application identity, and bundled environment configuration. Preserve the current service-map API as the integration boundary so routes and UI require minimal change, while the dependency graph, config loader, examples, and operator guide become profile-aware.

**Tech Stack:** Next.js 16, React 19, TypeScript 5.9, Node.js 24 test runner, pnpm, Go Deploy Agent, JSON/YAML configuration.

**Spec:** `docs/superpowers/specs/2026-11-11-w4s-project-profile-design.md`

## Global Constraints

- `RELEASE_PROJECT` accepts only `ips` or `w4s`; a missing value selects `ips`, while any unsupported non-empty value fails clearly.
- IPS service order remains `CMS`, `WFO`, `IPS`, `CTH`, `NCH`, `RPT`, `LOG`, `DWH`, `PMT`.
- W4S service order is exactly `WFO`, `LOG`, `CMS`, `CTH`, `W4S`, `NCH`, `PMT`, `AI`.
- IPS images remain `vknighthub/ips_o24<service>` and W4S images are `vknighthub/w4s_o24<service>`.
- IPS remains the default so the current production deployment does not require an immediate environment-variable change.
- W4S examples and documentation contain placeholders only; no secret, token, password, tunnel ID, account ID, or real private server address is committed.
- Promotion remains immutable-digest based; no build or Deploy Agent authentication behavior changes.

## Review Focus

- Module initialization and test isolation when different tests change `RELEASE_PROJECT`; profile resolution must be testable without stale import-time state.
- An invalid non-empty `RELEASE_PROJECT` must fail rather than falling back to IPS.
- Type narrowing must continue to reject services outside the active profile in every API that uses `isBuildServiceCode`.
- Dependency-graph fallback must include every active-profile service and never services from the other profile.
- Explicit `CONTROL_CONFIG_PATH` must take precedence over the bundled profile config so self-hosted deployments remain compatible.

---

### Task 1: Typed project profiles and active service map

**Files:**
- Create: `apps/control-center/lib/projectProfile.ts`
- Create: `apps/control-center/lib/projectProfile.test.ts`
- Modify: `apps/control-center/lib/github/serviceMap.ts`
- Modify: `apps/control-center/lib/github/serviceMap.test.ts`

**Interfaces:**
- Produces: `ProjectCode = 'ips' | 'w4s'`, `ProjectProfile`, `resolveProjectCode(value?: string): ProjectCode`, `getProjectProfile(code?: ProjectCode): ProjectProfile`, and active `BUILD_SERVICES`/`imageRepositoryFor()` exports.
- Preserves: `BuildServiceCode`, `isBuildServiceCode()`, `githubServiceForAgentCode()`, and `resolveAgentServiceCode()` for all current consumers.

- [ ] **Step 1: Write failing profile-resolution tests**

Test missing, empty, trimmed/case-normalized IPS/W4S values and assert an unsupported non-empty value throws an error listing `ips` and `w4s`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm test -- lib/projectProfile.test.ts`

Expected: FAIL because `projectProfile.ts` and its exports do not exist.

- [ ] **Step 3: Implement the typed profile catalog and pure resolver**

Define immutable IPS and W4S profile entries containing code, application name, ordered services, image prefix, and bundled config filename. Keep resolution pure by accepting an explicit value; expose the active profile separately for production consumers.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `pnpm test -- lib/projectProfile.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing service-map tests for both profiles**

Assert exact service order, exact image repository mapping, agent-code round trips, W4S rejection of `IPS/RPT/DWH`, and IPS rejection of `W4S/AI`. Use explicit profile-bound helpers so both profiles can be exercised in one process.

- [ ] **Step 6: Run service-map tests and verify RED**

Run: `pnpm test -- lib/github/serviceMap.test.ts`

Expected: FAIL because profile-bound helpers are missing and current mappings are hard-coded to IPS.

- [ ] **Step 7: Derive service-map behavior from project profiles**

Add profile-bound helper functions and keep active exports backed by the process-selected profile. Do not duplicate service arrays or prefixes in `serviceMap.ts`.

- [ ] **Step 8: Run focused and full tests**

Run: `pnpm test -- lib/projectProfile.test.ts lib/github/serviceMap.test.ts && pnpm test`

Expected: all tests PASS.

- [ ] **Step 9: Commit Task 1**

```bash
git add apps/control-center/lib/projectProfile.ts apps/control-center/lib/projectProfile.test.ts apps/control-center/lib/github/serviceMap.ts apps/control-center/lib/github/serviceMap.test.ts
git commit -m "feat: add IPS and W4S project profiles"
```

### Task 2: Profile-aware environment configuration and application identity

**Files:**
- Create: `apps/control-center/config/environments.ips.json`
- Create: `apps/control-center/config/environments.w4s.json`
- Create: `apps/control-center/lib/config.test.ts`
- Modify: `apps/control-center/lib/config.ts`
- Modify: `apps/control-center/config/environments.json`
- Modify: `apps/control-center/app/layout.tsx`
- Modify: `apps/control-center/app/components/release-control/DashboardHeader.tsx`
- Modify: `config/environments.example.json`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `getProjectProfile()` from Task 1.
- Produces: `resolveControlConfigPath(cwd: string, explicitPath?: string, projectCode?: ProjectCode): string` and profile-derived dashboard/application metadata.

- [ ] **Step 1: Write failing configuration-path precedence tests**

Assert an explicit `CONTROL_CONFIG_PATH` wins, W4S selects `config/environments.w4s.json`, IPS/default selects `config/environments.ips.json`, and invalid profiles fail through Task 1.

- [ ] **Step 2: Run config tests and verify RED**

Run: `pnpm test -- lib/config.test.ts`

Expected: FAIL because the path resolver and profile files do not exist.

- [ ] **Step 3: Implement path selection and split bundled configs**

Resolve absolute and relative explicit paths safely, otherwise select the active profile file. Keep the legacy `environments.json` as a backward-compatible IPS copy or documented redirect source, and retain environment-variable substitution and validation.

- [ ] **Step 4: Run config tests and verify GREEN**

Run: `pnpm test -- lib/config.test.ts`

Expected: PASS.

- [ ] **Step 5: Replace IPS fallback labels with active-profile identity**

Use the selected profile for page metadata and header fallback text; retain loaded config `applicationName` as the highest-priority runtime value.

- [ ] **Step 6: Update safe configuration examples**

Add `RELEASE_PROJECT=ips` to the root example, document the W4S value, replace any real-looking credential currently present with placeholders, and add W4S-specific agent URL variable placeholders used by its bundled config.

- [ ] **Step 7: Run typecheck, tests, and production build**

Run: `pnpm typecheck && pnpm test && pnpm build`

Expected: all commands exit 0.

- [ ] **Step 8: Commit Task 2**

```bash
git add .env.example config/environments.example.json apps/control-center/config apps/control-center/lib/config.ts apps/control-center/lib/config.test.ts apps/control-center/app/layout.tsx apps/control-center/app/components/release-control/DashboardHeader.tsx
git commit -m "feat: load profile-specific control configuration"
```

### Task 3: W4S-aware dependency graph and affected-service safety

**Files:**
- Modify: `apps/control-center/lib/github/w4sGraph.ts`
- Modify: `apps/control-center/lib/github/w4sGraph.test.ts`
- Modify: `apps/control-center/lib/affectedServices/resolver.ts`
- Modify: `apps/control-center/lib/affectedServices/resolver.test.ts`

**Interfaces:**
- Consumes: active `BUILD_SERVICES`, profile-bound catalogs, and current live GitHub workflow parsing.
- Preserves: `fetchDependencyGraph()` and `resolveAffectedServices()` return types used by API routes and UI.

- [ ] **Step 1: Add failing W4S workflow graph tests**

Fixture a workflow containing `WFO/LOG/CMS/CTH/W4S/NCH/PMT/AI` with W4S image prefixes; assert W4S, AI, and PMT are parsed as buildable and IPS-only services are ignored under the W4S profile.

- [ ] **Step 2: Run graph tests and verify RED**

Run: `RELEASE_PROJECT=w4s pnpm test -- lib/github/w4sGraph.test.ts`

Expected: FAIL because the current type/catalog is IPS-only at module initialization.

- [ ] **Step 3: Make graph parsing/catalog use profile-bound helpers**

Keep live workflow and solution inspection as the source of dependency facts, but scope `missingServices`, service loops, and accepted workflow labels to the active profile.

- [ ] **Step 4: Add failing affected-service tests**

Assert direct W4S/AI/PMT changes select the corresponding service; graph-unavailable, workflow-change, truncated compare, and unknown-path fallbacks return exactly the active W4S catalog in its configured order.

- [ ] **Step 5: Run resolver tests and verify RED**

Run: `RELEASE_PROJECT=w4s pnpm test -- lib/affectedServices/resolver.test.ts`

Expected: FAIL on at least the new module classifications or active-profile fallback assertions.

- [ ] **Step 6: Implement the minimal resolver adjustments**

Remove stale assumptions that W4S/AI/PMT are always unrelated and ensure all loops/fallbacks use the active catalog without creating separate IPS/W4S resolver implementations.

- [ ] **Step 7: Verify both profiles and full suite**

Run: `RELEASE_PROJECT=ips pnpm test && RELEASE_PROJECT=w4s pnpm test && pnpm typecheck`

Expected: both suites and typecheck PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add apps/control-center/lib/github/w4sGraph.ts apps/control-center/lib/github/w4sGraph.test.ts apps/control-center/lib/affectedServices/resolver.ts apps/control-center/lib/affectedServices/resolver.test.ts
git commit -m "feat: scope dependency analysis to active project"
```

### Task 4: Complete W4S Deploy Agent configuration kit

**Files:**
- Create: `examples/w4s/server/agent-config.dev.example.json`
- Create: `examples/w4s/server/agent-config.uat.example.json`
- Create: `examples/w4s/server/agent-config.prod.example.json`
- Create: `examples/w4s/server/.env.agent.example`
- Create: `examples/w4s/server/.env.deploy.example`
- Create: `examples/w4s/server/docker-compose.agent.yml`
- Create: `examples/w4s/server/docker-compose.application.fragment.yml`
- Create: `examples/w4s/server/cloudflared-config.example.yml`
- Create: `scripts/validate-w4s-kit.mjs`
- Modify: `apps/control-center/package.json`

**Interfaces:**
- Produces: three environment-specific agent templates with identical eight-service catalogs and `pnpm validate:w4s-kit` for structural/secret checks.

- [ ] **Step 1: Write the failing kit validator**

The validator must load all three agent JSON files and assert exact service order, unique codes/compose/container/image-env keys, correct `vknighthub/w4s_o24` repositories, valid DEV/UAT/PROD environment values, referenced compose services, and absence of forbidden IPS image prefixes or secret-like literal values.

- [ ] **Step 2: Run validator and verify RED**

Run: `pnpm validate:w4s-kit`

Expected: FAIL because the W4S example files do not exist.

- [ ] **Step 3: Add the W4S server kit**

Define all eight services with `o24-*` agent codes, matching compose/container names, `O24_<SERVICE>_IMAGE` keys, 90-second health timeouts, image cleanup defaults, placeholder HMAC values, and separate environment identity in each agent config.

- [ ] **Step 4: Run validator and verify GREEN**

Run: `pnpm validate:w4s-kit`

Expected: PASS and report eight services for each environment.

- [ ] **Step 5: Validate JSON/YAML and Deploy Agent compatibility**

Run: `pnpm validate:w4s-kit && docker compose -f examples/w4s/server/docker-compose.agent.yml config >/dev/null && go test ./...`

Working directories: repository root for pnpm/compose; `apps/deploy-agent` for Go tests.

Expected: all commands exit 0.

- [ ] **Step 6: Commit Task 4**

```bash
git add examples/w4s scripts/validate-w4s-kit.mjs apps/control-center/package.json
git commit -m "feat: add complete W4S agent deployment kit"
```

### Task 5: W4S installation and operations guide

**Files:**
- Create: `docs/W4S_DEPLOYMENT.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: project variables and example files from Tasks 1–4.
- Produces: an ordered operator checklist for Vercel, Redis, GitHub, agents, Cloudflare, smoke tests, promotion, rollback, and isolation verification.

- [ ] **Step 1: Write the W4S deployment guide**

Document: separate Vercel project/root directory/domain; `RELEASE_PROJECT=w4s`; separate Upstash and secrets; GitHub Actions permissions; per-environment agent installation; Cloudflare hostnames as placeholders; seed users; reconcile job; eight-service smoke checks; DEV → UAT → PROD immutable-digest promotion; rollback; and a final check that no IPS endpoint/image/data is visible.

- [ ] **Step 2: Update README navigation and profile matrix**

Explain the default IPS compatibility behavior and link directly to the W4S guide and example kit.

- [ ] **Step 3: Run documentation/config validation**

Run: `pnpm validate:w4s-kit && rg -n "vknighthub/ips_o24|release-control\.vknight\.io\.vn|deploy-(dev|uat|prod)\.vknight\.io\.vn" examples/w4s docs/W4S_DEPLOYMENT.md`

Expected: validator PASS; ripgrep returns no accidental IPS production values in W4S artifacts.

- [ ] **Step 4: Commit Task 5**

```bash
git add README.md docs/W4S_DEPLOYMENT.md
git commit -m "docs: add W4S release control deployment guide"
```

### Task 6: Full verification and GitHub pull request

**Files:**
- Modify only if verification uncovers defects in files owned by Tasks 1–5.

**Interfaces:**
- Produces: a verified feature branch and reviewable pull request targeting `main`.

- [ ] **Step 1: Install exact dependencies**

Run: `pnpm install --frozen-lockfile`

Working directory: `apps/control-center`.

Expected: exit 0 without lockfile changes.

- [ ] **Step 2: Verify Control Center under IPS**

Run: `RELEASE_PROJECT=ips pnpm typecheck && RELEASE_PROJECT=ips pnpm test && RELEASE_PROJECT=ips pnpm build`

Expected: all commands exit 0.

- [ ] **Step 3: Verify Control Center under W4S**

Run: `RELEASE_PROJECT=w4s pnpm typecheck && RELEASE_PROJECT=w4s pnpm test && RELEASE_PROJECT=w4s pnpm build`

Expected: all commands exit 0.

- [ ] **Step 4: Verify Deploy Agent and W4S kit**

Run: `go test ./...` in `apps/deploy-agent`, then `pnpm validate:w4s-kit` and `docker compose -f examples/w4s/server/docker-compose.agent.yml config` at the repository root.

Expected: all commands exit 0.

- [ ] **Step 5: Audit diff and secrets**

Run: `git diff --check origin/main...HEAD`, inspect `git diff --stat origin/main...HEAD`, and search changed files for token/password/private-key patterns and IPS production endpoints inside W4S artifacts.

Expected: no whitespace errors, unexpected generated artifacts, secrets, or cross-project references.

- [ ] **Step 6: Commit any verification-only correction**

Commit only if verification required a real code/config correction; otherwise leave history unchanged.

- [ ] **Step 7: Push branch and open pull request**

Push `feat/w4s-project-profile` and open a PR to `main` summarizing profile isolation, exact W4S services, backward compatibility, deployment kit, and verification commands/results. Do not merge without BEN's explicit instruction.
