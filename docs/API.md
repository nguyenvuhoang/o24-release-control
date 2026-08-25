# Deploy Agent API

Tất cả endpoint `/api/*` yêu cầu các header:

```text
X-O24-Agent-Key
X-O24-Timestamp
X-O24-Signature
```

Canonical string để ký:

```text
METHOD\n
PATH_WITH_QUERY\n
UNIX_TIMESTAMP\n
SHA256_HEX_OF_RAW_BODY
```

Signature:

```text
HMAC-SHA256(apiSecret, canonicalString)
```

Agent chấp nhận timestamp lệch tối đa 300 giây.

## Health

```http
GET /health
```

Không yêu cầu HMAC. Chỉ trả trạng thái cơ bản, không trả thông tin Docker.

## Agent status

```http
GET /api/status
```

## Services

```http
GET /api/services
```

Trả trạng thái container, health, image ID, digest và OCI revision label.

## Host metrics

```http
GET /api/host/metrics
```

Snapshot tài nguyên của server đang chạy agent (CPU, RAM, swap, disk, số container, uptime, OS/kernel) — dùng để hiển thị "Server Health" trên Control Center trước khi build/deploy/promote. Luôn trả 200 với dữ liệu lấy được tốt nhất có thể; một chỉ số lấy lỗi (ví dụ `docker system df` timeout) chỉ bị bỏ qua (`omitempty`), không làm hỏng cả response. CPU/RAM/load/uptime/kernel là số liệu THỰC của host (Linux không namespace hoá `/proc/loadavg`, `/proc/stat`, `/proc/meminfo`, và kernel version dùng chung với host). `hostname`/`os` phản ánh chính container của agent — đặt `hostname` trong `agent-config.json` nếu muốn tên khác. Disk đo bằng `statfs` trên `hostDiskPath` (mặc định `compose.projectDirectory`) — phải là một path bind-mount thật từ host, không phải rootfs của container agent.

```json
{
  "hostname": "dev-app",
  "cpu": { "usagePercent": 24.8, "cores": 8, "load1": 1.42, "load5": 1.18, "load15": 0.96 },
  "memory": { "usedBytes": 8589934592, "totalBytes": 17179869184, "usagePercent": 50 },
  "swap": { "usedBytes": 0, "totalBytes": 2147483648 },
  "disk": { "usedBytes": 128000000000, "totalBytes": 256000000000, "usagePercent": 50 },
  "dockerDiskUsageBytes": 5368709120,
  "containers": { "running": 12, "stopped": 2, "restarting": 0 },
  "uptimeSeconds": 864000,
  "os": "Alpine Linux v3.20",
  "kernel": "6.8.0-45-generic",
  "sampledAt": "2026-08-23T10:00:00Z"
}
```

## Logs

```http
GET /api/services/{service}/logs?tail=500
```

`tail` từ 1 đến 2000.

## Restart

```http
POST /api/services/{service}/restart
{}
```

## Deploy

```http
POST /api/deploy
Content-Type: application/json
```

```json
{
  "requestId": "deployment-id",
  "service": "o24-wfo",
  "digest": "sha256:...",
  "requestedBy": "admin",
  "reason": "promote DEV -> UAT"
}
```

Agent tự ghép repository whitelist với digest:

```text
vknighthub/ips_o24wfo@sha256:...
```

Không chấp nhận repository khác hoặc tag mutable.

## Rollback

```http
POST /api/services/{service}/rollback
{}
```

Agent lấy `previousImage` từ lịch sử deployment thành công gần nhất.
