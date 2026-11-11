# W4S Project Profile Design

## Intent

Extend the existing O24 Release Control codebase so the same source can power a dedicated W4S Control Center without changing the behavior of the existing IPS deployment. W4S will run as a separate Vercel project at `release-w4s.vknight.io.vn`, with independent Redis data, credentials, agent endpoints, and release history.

## Goals

- Select the active product at deployment time with `RELEASE_PROJECT=ips|w4s`.
- Keep IPS as the default when `RELEASE_PROJECT` is omitted, preserving the current production deployment.
- Provide a fixed W4S catalog containing `WFO`, `LOG`, `CMS`, `CTH`, `W4S`, `NCH`, `PMT`, and `AI`.
- Map W4S services only to Docker Hub repositories named `vknighthub/w4s_o24<service>`.
- Keep DEV, UAT, and PROD agent configuration separate between IPS and W4S.
- Ensure build, registry sync, release snapshots, promote, rollback, affected-service analysis, and dashboard rendering all use the active profile.
- Supply complete W4S examples and an installation checklist without storing real secrets.

## Non-goals

- A multi-project selector inside one dashboard.
- Shared Redis keys, users, sessions, audit logs, or release state between IPS and W4S.
- Changing Deploy Agent authentication or immutable-digest promotion behavior.
- Deploying Vercel, creating Upstash databases, configuring Cloudflare, or changing external server state from this code change.
- Automatically migrating existing IPS release data into W4S.

## Anti-goals

- W4S must never display or deploy an IPS-only service such as `IPS`, `RPT`, or `DWH`.
- W4S must never construct an image under the `vknighthub/ips_o24` namespace.
- An invalid `RELEASE_PROJECT` value must not silently select a profile.
- Existing IPS deployments with no new environment variable must not change behavior.

## Constraints

- One source repository and one Control Center application remain the source of truth.
- Each Vercel project has its own environment variables and Upstash Redis instance.
- Agent service codes retain the existing `o24-<name>` convention.
- GitHub Actions remains responsible for builds; Control Center only dispatches and observes workflows.
- Promotion remains digest-based and does not rebuild images.
- Configuration examples contain placeholders only.

## Approaches Considered

### 1. Deployment-selected project profile — selected

Define typed IPS and W4S profiles in source and resolve one from `RELEASE_PROJECT`. All consumers use the resolved catalog and image mapping. This keeps one codebase while allowing two isolated Vercel deployments and prevents long-term drift.

### 2. Separate static configuration copies

Maintain distinct IPS and W4S copies of service maps and application configuration. This is initially explicit but duplicates behavior and makes fixes easy to apply to one product only.

### 3. One multi-project dashboard

Add a runtime project selector and namespace every Redis record and operation. This offers one login but requires deeper authorization, storage, routing, and safety changes and increases the chance of cross-project release mistakes.

## Selected Architecture

### Project profile

A focused profile module owns:

- profile code and display name;
- allowed build service codes in display order;
- Docker repository prefix;
- project-specific environment configuration path or defaults;
- validation of `RELEASE_PROJECT`.

`RELEASE_PROJECT` accepts exactly `ips` or `w4s` after normalization. Missing values resolve to `ips` for backward compatibility. Unsupported non-empty values cause a clear startup/configuration error.

The service-map API remains the compatibility boundary used by routes, repositories, and components. Its exported catalog and helpers are derived from the active profile instead of a hard-coded IPS array.

### Profiles

| Profile | Services | Docker repository rule |
|---|---|---|
| IPS | `CMS`, `WFO`, `IPS`, `CTH`, `NCH`, `RPT`, `LOG`, `DWH`, `PMT` | `vknighthub/ips_o24<lowercase-service>` |
| W4S | `WFO`, `LOG`, `CMS`, `CTH`, `W4S`, `NCH`, `PMT`, `AI` | `vknighthub/w4s_o24<lowercase-service>` |

The requested W4S order is retained in the dashboard and batch operations.

### Environment and data isolation

The W4S Vercel project will set:

- `RELEASE_PROJECT=w4s`;
- `GITHUB_REPO=w4s` and the W4S build workflow settings;
- W4S-only DEV/UAT/PROD agent URLs and HMAC credentials;
- a W4S-only Upstash Redis URL/token;
- a W4S-only `SESSION_SECRET`, reconciliation secret, and administrator/user data.

IPS continues to use its existing Vercel project and variables. No profile ID needs to be added to Redis keys because databases are physically separated; this also avoids altering existing IPS keys.

### Environment files

The Control Center selects a profile-specific bundled environment definition when `CONTROL_CONFIG_PATH` is absent. An explicit `CONTROL_CONFIG_PATH` continues to override the bundled path for Docker/self-hosted deployments. W4S examples use distinct agent host placeholders so operators cannot accidentally copy IPS endpoints unnoticed.

### Affected-service analysis

The dependency graph continues to inspect the configured GitHub repository. The active catalog limits results to profile services. W4S-specific modules (`W4S`, `AI`, `PMT`) become buildable under W4S, while IPS-only modules are excluded. Unknown or incomplete dependency data keeps the existing conservative fallback, but only across services in the active profile.

### Deploy Agent kit

Add W4S deployment examples for all eight services:

- agent config with `o24-*` codes, compose/container names, repositories, image environment keys, and health timeout;
- deploy environment placeholders;
- application compose fragment or mapping guidance;
- separate DEV/UAT/PROD installation checklist;
- Vercel, Redis, GitHub, Cloudflare, and verification checklist.

No real key, token, password, tunnel ID, account ID, or server address will be committed.

## Error Handling

- Invalid profile: fail with an error naming the accepted values.
- Service outside active profile: existing API validation returns `invalid_service` and lists only active services.
- Agent reports an unknown service code: it remains unmatched and cannot be deployed through a release action.
- W4S workflow returns an IPS-only service: reject it during build/release validation.
- Missing required external credentials: retain current environment-variable validation and fail before invoking the external operation.

## Testing

- Unit-test default IPS resolution, explicit IPS, explicit W4S, case normalization, whitespace normalization, and invalid values.
- Unit-test exact ordered service catalogs and image repositories for both profiles.
- Run service-code round-trip tests for every service in each profile.
- Test that W4S rejects `IPS`, `RPT`, and `DWH`; IPS rejects `W4S` and `AI`.
- Exercise affected-service behavior for W4S/AI/PMT and confirm the conservative fallback stays profile-scoped.
- Run the complete Control Center test suite, typecheck, production build, and Deploy Agent Go tests.
- Check examples for forbidden secret-like values and IPS image prefixes in W4S files.

## Rollout

1. Merge the profile implementation while IPS remains the default.
2. Verify the existing IPS Vercel deployment without setting `RELEASE_PROJECT`.
3. Create a separate W4S Vercel project from the same repository and set its root to `apps/control-center`.
4. Provision separate Redis and all W4S secrets.
5. Install/configure W4S agents in DEV, UAT, and PROD.
6. Verify health and registry sync, then test a DEV build/deploy.
7. Promote the same digest DEV to UAT and PROD and verify rollback.
8. Attach `release-w4s.vknight.io.vn` only after the end-to-end checks pass.

## Acceptance Criteria

- IPS behavior and its nine-service catalog remain unchanged when `RELEASE_PROJECT` is absent.
- With `RELEASE_PROJECT=w4s`, only the requested eight W4S services are visible and accepted.
- Every W4S image repository has the `vknighthub/w4s_o24` prefix.
- W4S and IPS use independent external configuration and persisted data.
- Full automated verification passes.
- An operator can deploy W4S DEV/UAT/PROD by following the committed checklist without needing an IPS secret.
