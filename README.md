# O24 Release Control

Bộ source code quản lý tập trung việc triển khai Docker theo luồng:

```text
DEV → UAT → PROD
```

Mỗi môi trường chạy một **Deploy Agent** nhỏ. Giao diện **Next.js Control Center** gọi các agent qua HTTPS/domain, nên người vận hành không cần SSH trực tiếp vào server trong thao tác triển khai hằng ngày.

## Thành phần

```text
apps/control-center    Next.js UI + server-side API
apps/deploy-agent      Go agent, chỉ cho phép thao tác các service whitelist
examples/server        Cấu hình mẫu cho từng Docker server
config                 Danh sách môi trường DEV/UAT/PROD
scripts                Build, tạo secret, chụp digest đang chạy
```

Tính năng có sẵn:

- Dashboard DEV/UAT/PROD tự refresh mỗi 15 giây.
- Xem trạng thái, health, image, digest, Git revision và thời gian chạy.
- Xem 500 dòng log gần nhất.
- Restart container.
- Deploy trực tiếp bằng immutable image digest.
- Promote đúng digest từ DEV sang UAT, từ UAT sang PROD.
- Rollback về image trước đó.
- Tự rollback khi container mới không healthy trong thời gian cấu hình.
- Audit log ai thao tác, lúc nào, môi trường nào và kết quả.
- Đăng nhập Control Center.
- HMAC SHA-256 giữa Control Center và Agent.
- Hỗ trợ Cloudflare Access Service Token.
- Không có API chạy shell tùy ý.

---

# 1. Yêu cầu

## Server Control Center

- Docker Engine.
- Docker Compose plugin.
- Một domain, ví dụ `release.vknight.io.vn`.

## Mỗi server DEV/UAT/PROD

- Docker Engine.
- Docker Compose plugin.
- Cho phép chạy một container agent.
- Agent được mount `/var/run/docker.sock` và thư mục Compose, ví dụ `/app`.
- Một domain hoặc Cloudflare Tunnel:

```text
deploy-dev.vknight.io.vn
deploy-uat.vknight.io.vn
deploy-prod.vknight.io.vn
```

Khuyến nghị chỉ cho Control Center truy cập các domain agent bằng Cloudflare Access Service Token.

---

# 2. Build hai image quản trị

Tại thư mục source:

```bash
chmod +x scripts/*.sh

VERSION=1.0.0 \
REGISTRY_PREFIX=vknighthub \
PUSH=true \
./scripts/build-control-images.sh
```

Tương đương:

```bash
docker build \
  -t vknighthub/o24-release-control:1.0.0 \
  ./apps/control-center

docker push vknighthub/o24-release-control:1.0.0

docker build \
  -t vknighthub/o24-deploy-agent:1.0.0 \
  ./apps/deploy-agent

docker push vknighthub/o24-deploy-agent:1.0.0
```

> Control Center dùng Next.js 16.2.11 trên Node.js 24. Deploy Agent là Go binary chạy trong image có Docker CLI và Compose plugin.

---

# 3. Chuyển server hiện tại khỏi `latest`

Hiện tại DEV/UAT/PROD đều đang khai báo `latest`. Không đổi version đang chạy ngay. Trước tiên chụp **digest thực tế của container hiện tại** trên từng server.

Ví dụ cho WFO:

```bash
sudo mkdir -p /app
sudo touch /app/.env.deploy

sudo ./scripts/capture-running-digest.sh \
  o24-wfo \
  vknighthub/ips_o24wfo \
  O24_WFO_IMAGE \
  /app/.env.deploy
```

Kết quả:

```env
O24_WFO_IMAGE=vknighthub/ips_o24wfo@sha256:...
```

Script tự backup file `.env.deploy` trước khi sửa.

Trong Docker Compose hiện tại, đổi duy nhất dòng image:

```yaml
services:
  o24-wfo:
    image: ${O24_WFO_IMAGE}
```

Giữ nguyên toàn bộ ports, volumes, networks và environment đang có.

Chạy lại bằng digest vừa chụp:

```bash
cd /app
sudo docker compose \
  --env-file /app/.env \
  --env-file /app/.env.deploy \
  up -d --no-deps --force-recreate o24-wfo
```

Kiểm tra:

```bash
sudo docker inspect o24-wfo \
  --format 'status={{.State.Status}} image={{.Config.Image}} image_id={{.Image}}'
```

Làm tương tự cho các service khác.

> Thực hiện riêng trên DEV, UAT và PROD vì ba container cùng ghi `latest` nhưng có thể đang chạy ba image ID khác nhau.

---

# 4. Cài Deploy Agent trên từng server

Ví dụ UAT tại `172.16.5.30`:

```bash
sudo mkdir -p /opt/o24-deploy-agent/agent-data
cd /opt/o24-deploy-agent
```

Copy các file sau từ thư mục `examples/server`:

```text
docker-compose.agent.yml
agent-config.example.json → agent-config.json
.env.agent.example        → .env.agent
```

Sửa `agent-config.json`:

```json
{
  "environment": "UAT",
  "listenAddr": ":9100",
  "compose": {
    "projectDirectory": "/app",
    "files": ["/app/docker-compose.yml"],
    "baseEnvFile": "/app/.env",
    "deployEnvFile": "/app/.env.deploy"
  },
  "services": [
    {
      "code": "o24-wfo",
      "displayName": "O24 Workflow",
      "composeService": "o24-wfo",
      "containerName": "o24-wfo",
      "imageRepository": "vknighthub/ips_o24wfo",
      "imageEnvKey": "O24_WFO_IMAGE",
      "healthTimeoutSeconds": 90
    }
  ]
}
```

Tạo key và secret:

```bash
../../scripts/generate-secrets.sh
```

Điền vào `.env.agent`:

```env
AGENT_API_KEY=...
AGENT_API_SECRET=...
```

Chạy agent:

```bash
sudo docker compose \
  -f docker-compose.agent.yml \
  up -d
```

Kiểm tra local:

```bash
curl http://127.0.0.1:9100/health
```

Response dự kiến:

```json
{"environment":"UAT","status":"ok","version":"1.0.0"}
```

Lặp lại cho DEV và PROD. Mỗi agent phải dùng key/secret khác nhau.

---

# 5. Đưa agent ra domain

Agent chỉ bind local:

```text
127.0.0.1:9100
```

Cloudflare Tunnel mẫu nằm tại:

```text
examples/server/cloudflared-config.example.yml
```

Ví dụ UAT:

```yaml
ingress:
  - hostname: deploy-uat.vknight.io.vn
    service: http://127.0.0.1:9100
  - service: http_status:404
```

Không mở trực tiếp port `9100`, Docker API hoặc SSH ra Internet.

Nên tạo Cloudflare Access Service Token riêng cho từng environment và chỉ cho Control Center truy cập.

---

# 6. Cài Control Center

Tại server trung tâm:

```bash
cp .env.example .env
cp config/environments.example.json config/environments.json
```

Tạo secret:

```bash
./scripts/generate-secrets.sh
```

Sửa `.env`:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-strong-password
SESSION_SECRET=your-random-session-secret

DEV_AGENT_KEY=...
DEV_AGENT_SECRET=...
UAT_AGENT_KEY=...
UAT_AGENT_SECRET=...
PROD_AGENT_KEY=...
PROD_AGENT_SECRET=...
```

Nếu dùng Cloudflare Access:

```env
DEV_CF_ACCESS_CLIENT_ID=...
DEV_CF_ACCESS_CLIENT_SECRET=...
```

Sửa domain trong `config/environments.json`, sau đó chạy:

```bash
docker compose -f compose.control-center.yml up -d --build
```

Kiểm tra local:

```bash
curl -I http://127.0.0.1:8088/login
```

Đưa domain Control Center trỏ tới:

```text
http://127.0.0.1:8088
```

---

# 7. Quy trình sử dụng

## Build ứng dụng nghiệp vụ một lần

Ví dụ WFO:

```bash
COMMIT_SHA="$(git rev-parse --short=12 HEAD)"

docker buildx build \
  --push \
  --label "org.opencontainers.image.revision=$COMMIT_SHA" \
  -t "vknighthub/ips_o24wfo:sha-$COMMIT_SHA" \
  .
```

Lấy digest:

```bash
docker buildx imagetools inspect \
  "vknighthub/ips_o24wfo:sha-$COMMIT_SHA"
```

## Deploy DEV

1. Mở Control Center.
2. Chọn service `o24-wfo` tại DEV.
3. Nhấn **Deploy**.
4. Dán `sha256:...`.

## Promote DEV → UAT

Nhấn:

```text
Promote → UAT
```

Control Center đọc digest đang chạy thực tế tại DEV và yêu cầu agent UAT deploy đúng digest đó. Không build lại.

## Promote UAT → PROD

Nhấn:

```text
Promote → PROD
```

Cùng một digest được chuyển tiếp.

---

# 8. Rollback

Agent lưu lịch sử tại:

```text
/opt/o24-deploy-agent/agent-data/deployments.jsonl
```

Nhấn **Rollback** để quay về `previousImage` của lần deploy thành công gần nhất.

Nếu image mới không lên trạng thái running/healthy trong thời gian `healthTimeoutSeconds`, agent tự động khôi phục image trước đó.

Container chưa khai báo Docker healthcheck sẽ được chấp nhận khi trạng thái là `running` và health là `none`. PROD nên bổ sung healthcheck thực tế.

---

# 9. Bảo mật trước khi dùng PROD

Bộ này phù hợp để triển khai thử. Trước PROD cần tối thiểu:

1. Dùng Cloudflare Access Service Token cho tất cả domain agent.
2. Không mở port `9100` public.
3. Mỗi environment dùng API key/secret riêng.
4. Rotate secret định kỳ.
5. Chỉ whitelist service cần quản lý trong `agent-config.json`.
6. Không thêm API terminal/shell vào agent.
7. Backup `/app/.env.deploy` và `agent-data`.
8. Bảo vệ domain Control Center bằng Cloudflare Access hoặc VPN ngoài lớp đăng nhập có sẵn.
9. Thêm quy trình hai người phê duyệt khi promote PROD nếu nhiều người vận hành.
10. Bảo vệ Docker socket: agent có quyền mạnh tương đương quản trị Docker host.

---

# 10. Chạy local để kiểm tra UI

Control Center mặc định bắt buộc HTTPS cho agent. Khi test local, đặt:

```env
ALLOW_HTTP_AGENTS=true
COOKIE_SECURE=false
```

Agent local vẫn yêu cầu HMAC. Cấu hình `baseUrl` có thể là:

```json
"baseUrl": "http://host.docker.internal:9100"
```

Trên Linux cần thêm host gateway hoặc dùng domain/tunnel thật.

---

# API

Chi tiết endpoint và cơ chế chữ ký nằm tại [docs/API.md](docs/API.md).

# Ghi chú triển khai

Các lưu ý đường dẫn Compose, healthcheck và xử lý sự cố nằm tại [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
