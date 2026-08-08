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
