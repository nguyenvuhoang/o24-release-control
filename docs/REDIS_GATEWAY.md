# Redis / KV storage: Upstash vs the self-hosted HTTP Gateway

Control Center's audit log, release snapshots, build pointers, snapshot-job
queue and user store all go through one chokepoint:
`apps/control-center/lib/kv.ts`'s `kvCommand(config, command)`. Every
repository builds a raw Redis command array (`['SET', key, value, 'NX']`,
`['ZADD', key, score, member]`, ...) exactly as it always has — which
backend actually answers that command is the one thing `REDIS_PROVIDER`
decides.

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
```

`REDIS_PROVIDER=http` is an explicit choice: if `REDIS_GATEWAY_URL` or
`REDIS_GATEWAY_TOKEN` is missing, `resolveKvConfig()` throws
`RedisConfigError` instead of silently falling back to the in-memory/file
tiers — a misconfigured Production deploy must fail loudly, not look healthy
while quietly losing durability.

## Gateway contract

`POST {REDIS_GATEWAY_URL}/v1/redis`, body `{"op": "...", ...}`, response
`{"result": ...}`. Auth: `Authorization: Bearer <REDIS_GATEWAY_TOKEN>` plus
`CF-Access-Client-Id` / `CF-Access-Client-Secret` when set. Every request
uses `cache: 'no-store'` and a bounded timeout (`lib/redisGateway.ts`).

Gateway v0.2.0 documents exactly 14 ops: `get`, `set`, `del`, `exists`,
`ttl`, `pttl`, `expire`, `getdel`, `incr`, `rateLimit`, `sadd`, `srem`,
`smembers`, `scard`, `compareAndDelete`. There is no arbitrary-command or
Lua-execution escape hatch, by design.

## How raw Redis commands map onto that contract

| Redis command used by a repository | Under `REDIS_PROVIDER=http` |
| --- | --- |
| `GET`, `DEL`, `EXISTS`, `TTL`, `PTTL`, `EXPIRE`, `GETDEL`, `INCR` | 1:1 to the matching op |
| `SET key value` (no flags) | `set` |
| `SET key value EX sec \| PX ms` (no `NX`) | `set` then `expire` — two calls, not atomic, but this path is only ever used for a best-effort cache write (`w4sGraph`'s dependency-graph cache) that already tolerates a failed/lost write |
| `SET key value NX [EX \| PX]` | **Emulated**, not 1:1 — see "SET NX" below |
| `MGET k1 k2 ...` | fanned out to one `get` per key (`Promise.all`) — MGET's only job here is a batch-read optimization, not an atomicity requirement |
| `SADD`, `SREM`, `SMEMBERS`, `SCARD` | 1:1 |
| `LPUSH`, `LTRIM`, `LRANGE` | **Not supported** — throws `GatewayUnsupportedCommandError` |
| `ZADD`, `ZREM`, `ZREVRANGE`, `ZRANGEBYSCORE` | **Not supported** — throws `GatewayUnsupportedCommandError` |

### `SET ... NX` (atomic append-if-absent)

This is the single most important guarantee in the codebase — it's what
makes audit append, release-snapshot create and user create-if-absent
idempotent, and what backs `w4sGraph`'s cross-instance build lock. Gateway
v0.2.0 has no `setnx`/conditional-set op, so it's built entirely from ops
that genuinely are atomic, never from an unsafe GET-then-SET race:

1. `sadd(key + ":__nx_claim", "1")` — atomic; the return value (1 = we
   claimed it, 0 = someone else already did) is the ONLY thing that decides
   who gets to create the record. Two concurrent callers can never both
   believe they won.
2. The claim's winner writes the real value (`set`, plus `expire` on both
   keys if a TTL was requested) and the call returns `'OK'`.
3. A loser polls `get(key)` briefly (five attempts, 50ms–800ms backoff,
   ~1.55s worst case) for the winner's write to become visible, then
   returns `null` — exactly the Upstash `SET NX` contract callers already
   branch on (`if (setResult !== 'OK') { GET key }`). If the winner's write
   never becomes visible within that window, it throws rather than return a
   result that can't actually be confirmed.

### What's genuinely not supported yet

Audit's recent-items index (`LPUSH`/`LTRIM`/`LRANGE`), the release index and
per-service index (`ZADD`/`ZREVRANGE`), and the snapshot-job retry queue
(`ZADD`/`ZRANGEBYSCORE`) all need ordering or pagination that `sadd`/
`smembers` alone can't give you without reconstructing a sorted index
client-side on every read — not attempted here, to avoid trading one
request-volume problem for a worse one. Calling these under
`REDIS_PROVIDER=http` throws `GatewayUnsupportedCommandError` with the
missing op named; callers propagate that as a controlled error (never a
silent empty list, never a crash with no explanation).

**To close this gap, the Gateway needs native ops along these lines** (exact
naming/shape is the Gateway maintainer's call — this is the contract the
adapter would consume):

```jsonc
// zadd — add/update a member's score in a sorted set
{ "op": "zadd", "key": "...", "score": 1732564000000, "member": "release:CMS:123:1" }
-> { "result": 1 }

// zrevrange — highest score first, inclusive start/stop index
{ "op": "zrevrange", "key": "...", "start": 0, "stop": 49 }
-> { "result": ["release:CMS:200:1", "release:CMS:199:1", ...] }

// zrangebyscore — ascending, inclusive score bounds, optional limit
{ "op": "zrangebyscore", "key": "...", "min": "-inf", "max": 1732564000000, "limit": 20 }
-> { "result": ["job:CMS:100", ...] }

// zrem — remove a member
{ "op": "zrem", "key": "...", "member": "..." }
-> { "result": 1 }
```

Until those exist, `REDIS_PROVIDER=http` is safe to use for build pointers,
build intents, user accounts and the `w4sGraph` cache/lock, but **not** a
full replacement for audit listing, release listing or the snapshot-job
reconciliation queue — see the migration section below.

## Migration / cutover

- Upstash stays configured (`KV_REST_API_URL`/`KV_REST_API_TOKEN` or the
  `UPSTASH_*` equivalents) for rollback. Nothing in this change deletes or
  touches the existing Upstash database.
- Switching `REDIS_PROVIDER=http` in Production should wait until:
  1. The Gateway gains the sorted-set ops above (or the audit/release/
     snapshot-job indexes are redesigned to not need them), and
  2. `REDIS_GATEWAY_URL`/`REDIS_GATEWAY_TOKEN`/`CF_ACCESS_CLIENT_ID`/
     `CF_ACCESS_CLIENT_SECRET` are set in Vercel's env for every
     environment that needs them, and
  3. Existing Upstash audit/release history has an accepted migration or
     recovery plan (a one-off export/import script reading the current
     Upstash `o24:audit:*` / `o24:release:*` keys and replaying them through
     the same `SET`/`ZADD` calls against the Gateway, once it supports
     `zadd`) — not built as part of this change, since it depends on the
     Gateway supporting the sorted-set ops first and on being able to
     actually read the current Upstash data (this environment could not
     reach Upstash to check remaining quota/export feasibility).
- Until then, use `REDIS_PROVIDER=http` only in Preview/staging to validate
  the parts it does support (build pointers/intents, user accounts, the
  w4sGraph dependency-graph cache and lock).
