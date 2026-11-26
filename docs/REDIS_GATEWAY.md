## 2026-11-26 Vercel transport incident

**Symptom:** after Gateway v0.3.0 went live, every Dashboard load logged
`[registry] ... lookup failed: Redis Gateway request timed out after
15000ms` for every service, plus `[releases/environment-state] ... failed`
and `[builds/[runId]] appendBuildAudit failed` — i.e. **every** op, reads
and writes alike, from the Vercel runtime specifically. Batching/
concurrency work (see the earlier commit reducing the per-load request
count from ~70 to ~24) did **not** fix it: the request *count* was never
the problem — every individual request was failing the same way.

**What we confirmed before touching anything:**
- A PowerShell client hitting the Gateway through Cloudflare Access
  succeeds, from a different network than Vercel's.
- The Gateway's own v0.3.0 smoke tests passed (from yet another network).
- The failure is unconditional per-op, not load-dependent — the opposite of
  an overloaded-server symptom, consistent instead with a transport-level
  dead end that happens to resolve right at the 15000ms boundary rather
  than failing fast (a connection attempt that never gets a response at
  all behaves exactly like this: it doesn't error quickly, it just sits
  until our own AbortController fires).
- `REDIS_GATEWAY_URL` resolves to **both** an IPv4 and an IPv6 Cloudflare
  address from this environment:
  ```
  $ nslookup redis-gateway.vknight.io.vn
  2606:4700:3037::ac43:826e   (AAAA)
  2606:4700:3035::6815:864    (AAAA)
  172.67.130.110              (A)
  104.21.8.100                (A)
  ```
  Node's `fetch` (undici) does not race IPv4/IPv6 (no Happy-Eyeballs) — it
  connects to whichever address `dns.lookup()` returns first, in the
  platform's default order (`verbatim`, i.e. unmodified getaddrinfo order,
  often AAAA-first on a dual-stack resolver). If a serverless runtime's
  outbound network doesn't actually support (or cleanly reject) IPv6 egress
  to that destination, that single attempt hangs with no fallback — a very
  well-documented class of bug on constrained/NAT'd serverless networks,
  and one that explains every observed fact here: it affects every op
  uniformly, it's unaffected by concurrency, and other clients on other
  networks are unaffected.

We also found and fixed a **real, independently-confirmed bug** while
investigating, in both `kv.ts`'s `kvCommandOnce` and `redisGateway.ts`'s
`gatewayCallOnce`: the abort timeout was cleared right after `fetch()`
itself resolved (i.e. once response *headers* arrived), **before**
`response.json()`/`.text()` was awaited — so a connection that connected
and sent headers promptly, but then stalled mid-body, had **no timeout at
all** protecting the body read. This is not what produced the specific
`"timed out after 15000ms"` message being seen (that message only fires
from the pre-headers `AbortError` path), but it's a real latent hang risk
in its own right, now fixed and regression-tested
(`redisGatewayTransport.test.ts`'s "timeout covers body read" test actually
exercises a server that sends headers then stalls, proving the fix).

**What shipped (all client-side, nothing in Gateway infra, no timeout
change):**
- **`instrumentation.ts`** (new): calls `dns.setDefaultResultOrder('ipv4first')`
  once at server boot, in the Node.js runtime only. This is a process-wide
  DNS *address-family ordering* change — not a TLS change — and applies
  equally to every outbound Node connection in this app (Gateway, GitHub,
  Docker Hub, Deploy Agent); none of those are known to need IPv6, so this
  is a safe default. Overridable without a redeploy via `DNS_RESULT_ORDER`
  (`ipv4first` default, or `verbatim` to restore Node's own default).
- **`lib/redisGatewayTransport.ts`** (new): extracts the Gateway's HTTP
  transport behind a small interface, with two implementations:
  - `fetch` (default): the same fetch-based call as before, but the abort
    timeout now demonstrably covers the full lifecycle including body
    consumption (the bug above), and it validates the raw response before
    trusting it (see `gatewayCallOnce` below).
  - `https-agent` (opt-in via `REDIS_GATEWAY_TRANSPORT=https-agent`): a
    dedicated `node:https.Agent` with `keepAlive` and an explicit `family: 4`
    (IPv4) preference, plus real socket-level phase timing (DNS lookup / TCP
    connect / TLS handshake / time-to-first-byte) — useful both as a
    fallback transport if `fetch`'s behavior is ever itself the problem, and
    as the more detailed half of the diagnostic endpoint below. Standard TLS
    certificate verification is never weakened (`rejectUnauthorized`'s
    default of `true` is never overridden). Off by default — never changes
    behavior unless explicitly selected.
- **`gatewayCallOnce`** (`redisGateway.ts`) now validates the raw response
  before trusting it, instead of just checking `response.ok`:
  - a 3xx is rejected explicitly (never silently followed, never mistaken
    for the Gateway's own response) — signals a Cloudflare Access/WAF/
    login page in front of the Gateway, not a Gateway-side failure;
  - an HTML body is rejected explicitly (classic WAF/challenge-page
    signature) instead of failing confusingly deep inside `JSON.parse`;
  - a 2xx body that isn't valid JSON, or that's JSON but missing both
    `result`/`error`, is rejected explicitly instead of silently becoming
    `result: undefined` (which would be indistinguishable from a real null
    result);
  - a network error's POSIX code (`ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, …)
    is now included in the thrown message when available — real diagnostic
    value, never sensitive, never a credential/header/body value.
- **`GET /api/admin/redis-diagnostics`** (new, admin-gated, read-only):
  compares `fetch` vs. `node:https` transports, each doing `GET /health`
  (best-effort — not part of the documented Gateway contract, so a 404
  there is itself a successful transport result) and `POST /v1/redis` with
  `get`/`mget` against two synthetic, never-written keys
  (`o24:diag:ping[2]`) — never real release/audit/user data. Reports DNS
  resolution (duration, every resolved address + family — the IPv4/IPv6
  evidence above, captured fresh from wherever this is actually running),
  HTTP status, content-type, `CF-Ray`, redirect detection, body length (not
  content), phase timings, and sanitized network error codes. Never returns
  response bodies, header values, the Gateway token, or CF-Access secrets.

**This incident is not closed by this commit.** Nobody on this task has
network access to `redis-gateway.vknight.io.vn` or to the live Vercel
deployment from the environment these changes were written in (the same
limitation noted below, under "Validation status", when this document was
first written) — so the DNS evidence above and the body-read-timeout fix
are both real, but the IPv4-preference hypothesis they motivate is NOT yet
confirmed against production. Deploy this, then call
`GET /api/admin/redis-diagnostics` from the actual Vercel deployment and
compare: a true transport-layer fix shows up as every probe succeeding with
a real `httpStatus` and timings in the tens-to-low-hundreds of
milliseconds, not as a 15000ms-bounded `errorCode: 'TIMEOUT'`. If `fetch`
probes still hang after the DNS fix but `https-agent` probes succeed, set
`REDIS_GATEWAY_TRANSPORT=https-agent` in production and re-run the
diagnostic to confirm before relying on it.

---

# Redis / KV storage: Upstash vs the self-hosted HTTP Gateway

Control Center's audit log, release snapshots, build pointers, snapshot-job
queue and user store all go through one chokepoint:
`apps/control-center/lib/kv.ts`'s `kvCommand(config, command)`. Every
repository builds a raw Redis command array (`['SET', key, value, 'NX']`,
`['ZADD', key, score, member]`, ...) exactly as it always has — which
backend actually answers that command is the one thing `REDIS_PROVIDER`
decides. `apps/control-center/lib/redisGateway.ts` is the adapter for the
self-hosted Gateway half of that decision, and this document is its
contract.

**Status:** this document specifies Gateway **v0.3.0**, which does not
exist yet — it is the target the vKnight team will build the standalone
Gateway against. The adapter in this repo (`lib/redisGateway.ts`) already
calls every op below exactly as specified here; it has not been run against
a live v0.3.0 instance (see "Validation status" below).

## Environment variables

```env
# "upstash" (default, or unset) | "http"
REDIS_PROVIDER=upstash

# Upstash / Vercel KV (unchanged) — used when REDIS_PROVIDER is unset or "upstash"
KV_REST_API_URL=
KV_REST_API_TOKEN=
# or the raw Upstash names, both are accepted:
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# Self-hosted HTTP Redis Gateway — used when REDIS_PROVIDER=http
REDIS_GATEWAY_URL=https://redis-gateway.vknight.io.vn
REDIS_GATEWAY_TOKEN=
CF_ACCESS_CLIENT_ID=
CF_ACCESS_CLIENT_SECRET=
# optional, falls back to KV_REQUEST_TIMEOUT_MS then 5000ms
REDIS_GATEWAY_TIMEOUT_MS=

# optional — "fetch" (default) or "https-agent" (see the 2026-11-26
# transport-incident note above). Only switch this after confirming via
# GET /api/admin/redis-diagnostics that https-agent actually helps.
REDIS_GATEWAY_TRANSPORT=

# optional — "ipv4first" (default, set in instrumentation.ts) or "verbatim"
# to restore Node's own default DNS address-family ordering process-wide.
DNS_RESULT_ORDER=
```

`REDIS_PROVIDER=http` is an explicit choice: if `REDIS_GATEWAY_URL` or
`REDIS_GATEWAY_TOKEN` is missing, `resolveKvConfig()` throws
`RedisConfigError` instead of silently falling back to the in-memory/file
tiers — a misconfigured Production deploy must fail loudly, not look healthy
while quietly losing durability.

## Transport

`POST {REDIS_GATEWAY_URL}/v1/redis`, one op per request, body
`{"op": "<name>", ...params}`, success response `{"result": <value>}`.

**Headers** (every request):
```
Content-Type: application/json
Authorization: Bearer <REDIS_GATEWAY_TOKEN>
CF-Access-Client-Id: <CF_ACCESS_CLIENT_ID>        (only if configured)
CF-Access-Client-Secret: <CF_ACCESS_CLIENT_SECRET> (only if configured)
```

**Error response** (any non-2xx status): `{"error": "<human-readable message>"}`.
The adapter treats the HTTP status, not the body, as authoritative:
- `4xx` — malformed op/args, bad auth, bad token. Never retried by the
  adapter (retrying a bad request can't change the outcome).
- `5xx`, or the request never completing (network error / timeout) —
  transient. Retried up to twice (3 attempts total, exponential backoff +
  jitter, 150ms base / 1500ms cap) **except** for the five ops listed under
  "Non-idempotent ops" below, which are never auto-retried no matter what.

**No arbitrary commands, no Lua.** Every op below is a fixed, individually
specified operation. The Gateway must reject (400) a request whose `op` is
not one of these — it must never proxy an arbitrary Redis command string or
accept a script body.

**Timeouts.** The adapter aborts a request after `REDIS_GATEWAY_TIMEOUT_MS`
(default 5000ms) and treats the abort as transient. The Gateway's own
upstream Redis timeout should be comfortably shorter than that so a slow
Redis produces a clean error response rather than the adapter's own abort
racing it.

## Non-idempotent ops

`incr`, `getdel`, `rateLimit`, `compareAndDelete`, `lpush` — a blind retry of
any of these can observe or cause a different outcome than the first
attempt even when that first attempt actually succeeded server-side before
the response was lost (double increment, a `getdel` that already consumed
the value, a rate-limit window counted twice, a compare that no longer
matches after already deleting, a list push that would append the same
value twice). The adapter never retries these automatically. Every other op
reaches the same end state no matter how many times it's applied — this
includes conditional `set`, because every id/value pair this codebase sends
is deterministic, so replaying a `SET NX` either re-confirms the same write
or correctly discovers it already happened.

---

## Operation contracts

Every op's `params` are merged into the request body alongside `"op"`, e.g.
`{"op": "get", "key": "foo"}`.

### `get`

Read a string key.

```jsonc
// Request
{ "op": "get", "key": "o24:audit:record:abc123" }
// Response — the stored string, or null if the key doesn't exist
{ "result": "…json string…" }
{ "result": null }
```
Error: none specific to this op beyond the shared contract above.

### `set`

Write a string key, optionally conditional and/or with a TTL. **This is the
single most important op in the contract** — it backs every idempotent
create-if-absent in the codebase (audit append, release-snapshot create,
user create) and the `w4sGraph` cross-instance build lock, and it MUST be
atomic as a single server-side operation (check-and-write under one lock),
never decomposed internally into a separate existence check plus a
separate write.

```jsonc
// Request — every field except key/value is optional
{
  "op": "set",
  "key": "o24:release:record:release:CMS:123:1",
  "value": "…json string…",
  "nx": true,        // optional: only set if the key does NOT already exist
  "xx": true,        // optional: only set if the key DOES already exist (mutually exclusive with nx)
  "ex": 120,          // optional: expire after this many seconds
  "px": 60000         // optional: expire after this many milliseconds (mutually exclusive with ex)
}
// Response
{ "result": "OK" }   // the write happened
{ "result": null }   // nx/xx condition was not met — nothing was written, nothing was overwritten
```
Semantics (must match Redis `SET key value [NX|XX] [EX seconds|PX milliseconds]`):
- No `nx`/`xx`: always writes and returns `"OK"`.
- `nx: true`: writes only if the key is absent. Returns `"OK"` if it wrote, `null` if the key already existed (value is untouched).
- `xx: true`: writes only if the key already exists. Returns `"OK"` if it wrote, `null` if the key was absent (nothing is created).
- `ex`/`px`: sets/replaces the key's TTL as part of the same write when the write happens; irrelevant when the write didn't happen (`null` case) — no TTL is touched on an existing, untouched key.
- `ex` and `px` are mutually exclusive, as are `nx` and `xx`; sending both of a pair is a 400.
- Error: 400 if `key`/`value` is missing or either exclusive pair is both set.

### `del`

```jsonc
{ "op": "del", "key": "o24:build:pointer:CMS" }
// Response: number of keys actually removed (0 or 1 here — this adapter never sends multiple keys)
{ "result": 1 }
```

### `exists`

```jsonc
{ "op": "exists", "key": "o24:user:record:admin" }
// Response: 1 if the key exists, 0 otherwise
{ "result": 1 }
```

### `ttl` / `pttl`

Remaining time-to-live.

```jsonc
{ "op": "ttl", "key": "o24:depgraph:lock:nguyenvuhoang/w4s:abc" }
// Response: seconds remaining; -1 if the key exists with no TTL; -2 if the key doesn't exist
{ "result": 42 }
```
`pttl` is identical except the result is milliseconds.

### `expire`

Set (or replace) a key's TTL in seconds, without touching its value.

```jsonc
{ "op": "expire", "key": "o24:depgraph:cache:...", "seconds": 300 }
// Response: 1 if the TTL was set, 0 if the key doesn't exist
{ "result": 1 }
```

### `getdel`

Atomically read a key and delete it in the same operation.

```jsonc
{ "op": "getdel", "key": "..." }
// Response: the value that was there (now deleted), or null if the key didn't exist
{ "result": "…" }
```
Non-idempotent: a retried `getdel` would see `null` even if the first,
unacknowledged attempt actually succeeded — never auto-retried.

### `incr`

Atomically increment an integer-valued key (creating it at 0 first if absent).

```jsonc
{ "op": "incr", "key": "o24:counter:..." }
// Response: the value AFTER incrementing
{ "result": 6 }
```
Error: 400 if the existing value isn't a valid integer string. Non-idempotent.

### `rateLimit`

Atomic fixed-window rate check-and-increment. Not currently called by any
repository in this codebase — specified here for completeness/future use
(e.g. login-attempt throttling).

```jsonc
{ "op": "rateLimit", "key": "login:admin", "limit": 5, "windowSeconds": 60 }
// Response
{ "result": { "allowed": true, "remaining": 2 } }
{ "result": { "allowed": false, "remaining": 0 } }
```
`allowed: false` means this call itself was counted against the window and
rejected (i.e. calling it IS the attempt — it's not a side-effect-free
peek). Non-idempotent.

### `sadd` / `srem` / `smembers` / `scard`

Unordered string set membership.

```jsonc
{ "op": "sadd", "key": "...", "member": "..." }
// Response: 1 if newly added, 0 if it was already a member
{ "result": 1 }

{ "op": "srem", "key": "...", "member": "..." }
// Response: 1 if removed, 0 if it wasn't a member
{ "result": 1 }

{ "op": "smembers", "key": "..." }
// Response: all members, any order
{ "result": ["a", "b", "c"] }

{ "op": "scard", "key": "..." }
// Response: member count (0 if the key doesn't exist)
{ "result": 3 }
```

### `compareAndDelete`

Atomic CAS delete: remove a key only if its current value matches exactly.
Not currently called by any repository (the one lock in this codebase,
`w4sGraph`'s build-graph lock, relies on TTL expiry rather than an explicit
release) — specified here for completeness/future use by any future
explicit lock-release path.

```jsonc
{ "op": "compareAndDelete", "key": "...", "value": "expected-current-value" }
// Response: true if it matched and was deleted, false if the value didn't match (key untouched) or the key didn't exist
{ "result": true }
```
Non-idempotent.

### `mget`

Batch read. **New in v0.3.0** — v0.2.0 had no batch-read op, so the adapter
previously fanned this out into N separate `get` calls; this must now be one
request.

```jsonc
{ "op": "mget", "keys": ["o24:release:record:a", "o24:release:record:b"] }
// Response: one entry per input key, SAME ORDER, null for any key that doesn't exist
{ "result": ["…json…", null] }
```
Error: 400 if `keys` is missing, not an array, or empty (the adapter never
sends an empty array — it short-circuits to `[]` without a request).

### `lpush`

Prepend a value to a list (creating it if absent). **New in v0.3.0.**

```jsonc
{ "op": "lpush", "key": "o24:audit:index", "value": "record-id-123" }
// Response: the list's length AFTER the push
{ "result": 42 }
```
Non-idempotent (each call appends one more element, by design — used for a
recent-items index where every append must count).

### `ltrim`

Keep only the elements within an inclusive index range, dropping the rest.
**New in v0.3.0.**

```jsonc
{ "op": "ltrim", "key": "o24:audit:index", "start": 0, "stop": 999 }
// Response: simple confirmation
{ "result": "OK" }
```
`start`/`stop` are 0-based list indices (0 = head/most-recently-pushed end,
since every push in this codebase is `lpush`), **inclusive on both ends**,
matching Redis `LTRIM`. Negative indices (Redis-style, -1 = last element) are
part of the contract even though this adapter never sends one today. If the
key doesn't exist, this is a no-op (not an error). Idempotent — trimming to
the same bounds twice has the same result.

### `lrange`

Read a range of list elements without removing them. **New in v0.3.0.**

```jsonc
{ "op": "lrange", "key": "o24:audit:index", "start": 0, "stop": 29 }
// Response: elements from start to stop inclusive, in list order (head first)
{ "result": ["id-30", "id-29", "...", "id-1"] }
```
Same inclusive 0-based (negative-capable) index semantics as `ltrim`. Empty
array if the key doesn't exist or the range is out of bounds — never an
error for an out-of-range request.

### `zadd`

Add or update a member's score in a sorted set (creating the set if absent).
**New in v0.3.0.**

```jsonc
{ "op": "zadd", "key": "o24:release:index", "score": 1732564000000, "member": "release:CMS:123:1" }
// Response: 1 if the member was newly added, 0 if it already existed (its score was just updated)
{ "result": 1 }
```
`score` is a float (this codebase always sends an integer epoch-ms
timestamp, via `Date.parse(...)`, but the Gateway must accept any IEEE-754
double). Idempotent — adding the same member at the same score twice leaves
the set unchanged.

### `zrem`

Remove a member from a sorted set.

```jsonc
{ "op": "zrem", "key": "o24:snapshot-job:pending", "member": "job-id" }
// Response: 1 if removed, 0 if it wasn't a member
{ "result": 1 }
```

### `zrevrange`

Read members by rank, **highest score first**, inclusive 0-based index range.
**New in v0.3.0.**

```jsonc
{ "op": "zrevrange", "key": "o24:release:index", "start": 0, "stop": 49 }
// Response: up to 50 members, newest (highest score) first
{ "result": ["release:CMS:200:1", "release:CMS:199:1", "..."] }
```
`start`/`stop` are ranks (0 = highest score), inclusive both ends,
negative-index-capable (Redis `ZREVRANGE` semantics). Empty array if the key
doesn't exist.

### `zrangebyscore`

Read members whose score falls within an inclusive range, **ascending by
score** (lowest first), with an optional offset/count page. **New in
v0.3.0.**

```jsonc
// Request — "offset"/"count" are both present or both absent
{ "op": "zrangebyscore", "key": "o24:snapshot-job:pending", "min": "-inf", "max": "1732564000000", "offset": 0, "count": 20 }
// Response: up to `count` members (or all matching, if offset/count are omitted), ascending score
{ "result": ["job:CMS:100", "job:CMS:101"] }
```
- `min`/`max` are strings so `"-inf"` / `"+inf"` can be sent (as Redis
  itself requires); a finite bound is sent as the decimal string of a
  number (e.g. `"1732564000000"`). Both bounds are **inclusive** — this
  adapter never sends the Redis `(` exclusive-bound prefix, but the Gateway
  should still accept it for forward compatibility with a future caller
  that does.
- `offset`/`count` page the ascending-order result the same way Redis's
  `LIMIT offset count` does: skip `offset` matches, then return up to
  `count` more. Omitted entirely (not `0`) when the adapter wants every
  match.
- Empty array if nothing matches or the key doesn't exist.

---

## Multi-step repository operations — is an atomic combined op needed?

Reviewing every repository call site for places that issue more than one
Gateway request to do one logical thing:

- **`auditRepository.ts`'s `append()`**: `SET ... NX` (one request, now
  atomic — see `set` above) followed by, only on the winning write,
  `LPUSH` then `LTRIM` as two separate requests to maintain the capped
  recent-items index. This two-step push+trim is **not new** — it was
  already two separate calls against Upstash before this migration, so it
  is not a regression this migration introduces, and a crash between the
  two leaves the index merely untrimmed (over-retained, never
  under-retained or corrupted) until the next successful append trims it
  back down. **Recommendation, not implemented in this PR:** an optional
  combined `lpushtrim` op (`{"op":"lpushtrim","key":...,"value":...,"maxLen":1000}`
  → pushes then trims to `maxLen` as one atomic server-side operation,
  returning the post-trim length) would close this gap if the Gateway team
  wants to take it on; the adapter does not depend on it and keeps using
  plain `lpush`+`ltrim` until/unless it exists.
- **`releaseRepository.ts`'s `writeIndexes()`**: one `ZADD` for the global
  index, one `ZADD` for the per-service index, and a conditional `SET` for
  the run-key and digest-key pointers — up to four independent requests,
  all idempotent (re-running any subset after a partial failure is safe,
  since every one of them is itself an idempotent op on a stable key). No
  combined op needed here — the risk is "briefly missing from the index",
  never a duplicate or corruption.
- **`snapshotJobStore.ts`**: every mutation does a plain `SET` of the job
  record and a `ZADD`/`ZREM` of the pending queue as two requests; same
  idempotent-retry-safe shape as above.

No other multi-request sequence in this codebase needs a combined op.

## Migration / cutover

- Upstash stays configured (`KV_REST_API_URL`/`KV_REST_API_TOKEN` or the
  `UPSTASH_*` equivalents) for rollback. Nothing in this change deletes or
  touches the existing Upstash database.
- Switching `REDIS_PROVIDER=http` in Production should wait until:
  1. Gateway v0.3.0 (this contract) is actually deployed and reachable, and
  2. `REDIS_GATEWAY_URL`/`REDIS_GATEWAY_TOKEN`/`CF_ACCESS_CLIENT_ID`/
     `CF_ACCESS_CLIENT_SECRET` are set in Vercel's env for every environment
     that needs them, and
  3. Existing Upstash audit/release history has an accepted migration or
     recovery plan (a one-off script reading the current Upstash
     `o24:audit:*` / `o24:release:*` keys and replaying them through the
     same `SET`/`ZADD`/`LPUSH` calls against the Gateway) — not built as
     part of this change: this environment could not reach either Upstash
     or `redis-gateway.vknight.io.vn` (DNS did not resolve) to assess
     remaining Upstash quota or export feasibility, or to run a live
     integration test against the new ops.

## Validation status

Every op above is covered by mocked-HTTP unit tests in
`apps/control-center/lib/redisGateway.test.ts` (request shape, response
parsing, retry policy, the native-SET single-request behavior, list/
sorted-set translation). None of it has been exercised against a real
Gateway — `redis-gateway.vknight.io.vn` does not resolve from this
environment. Treat this contract as the spec to build v0.3.0 against, and
re-run the adapter's test suite plus a live smoke test once that Gateway
exists and is reachable.
