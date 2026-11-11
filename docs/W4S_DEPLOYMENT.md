# W4S Release Control Deployment

Tài liệu này triển khai một Control Center W4S độc lập từ cùng repository O24 Release Control. W4S có Vercel project, Redis, secrets, users, audit log, release history và ba Deploy Agent riêng.

## 1. Phạm vi

W4S quản lý đúng tám service theo thứ tự:

```text
WFO, LOG, CMS, CTH, W4S, NCH, PMT, AI
```

Luồng phát hành:

```text
DEV → UAT → PROD
```

Mỗi lần promote sử dụng nguyên immutable digest đã chạy ở môi trường nguồn. UAT và PROD không build lại image.

## 2. Chuẩn bị dịch vụ độc lập

Tạo mới và không tái sử dụng tài nguyên của dự án khác:

- Vercel project: `o24-release-control-w4s`.
- Root Directory: `apps/control-center`.
- Production domain: `release-w4s.vknight.io.vn`.
- Một Upstash Redis database riêng.
- Ba hostname agent riêng cho DEV, UAT và PROD.
- Cloudflare Tunnel/Access application và Service Token riêng nếu agent được bảo vệ bằng Access.

Các hostname agent trong bộ mẫu là placeholder. Chọn hostname thực tế trước khi cấu hình Vercel và Cloudflare.

## 3. Cấu hình Vercel

Thiết lập các biến sau cho Production và các môi trường Vercel cần sử dụng:

```env
RELEASE_PROJECT=w4s
GITHUB_OWNER=nguyenvuhoang
GITHUB_REPO=w4s
GITHUB_WORKFLOW=build-o24.yml
GITHUB_BUILD_BRANCH=developer
GITHUB_API_VERSION=2026-03-10
GITHUB_TOKEN=CHANGE_ME_ACTIONS_WRITE_AND_CONTENTS_READ_TOKEN

W4S_DEV_AGENT_URL=https://REPLACE_WITH_DEV_AGENT_HOST
W4S_UAT_AGENT_URL=https://REPLACE_WITH_UAT_AGENT_HOST
W4S_PROD_AGENT_URL=https://REPLACE_WITH_PROD_AGENT_HOST

DEV_AGENT_KEY=CHANGE_ME
DEV_AGENT_SECRET=CHANGE_ME_AT_LEAST_32_RANDOM_CHARACTERS
UAT_AGENT_KEY=CHANGE_ME
UAT_AGENT_SECRET=CHANGE_ME_AT_LEAST_32_RANDOM_CHARACTERS
PROD_AGENT_KEY=CHANGE_ME
PROD_AGENT_SECRET=CHANGE_ME_AT_LEAST_32_RANDOM_CHARACTERS

SESSION_SECRET=CHANGE_ME_AT_LEAST_32_RANDOM_CHARACTERS
RECONCILE_CRON_SECRET=CHANGE_ME_AT_LEAST_32_RANDOM_CHARACTERS
COOKIE_SECURE=true
ALLOW_HTTP_AGENTS=false
```

Không đặt `CONTROL_CONFIG_PATH` trên Vercel. Control Center sẽ tự nạp `config/environments.w4s.json` khi `RELEASE_PROJECT=w4s`.

Liên kết Upstash riêng bằng một trong hai cặp biến mà ứng dụng hỗ trợ:

```env
KV_REST_API_URL=CHANGE_ME
KV_REST_API_TOKEN=CHANGE_ME
```

hoặc:

```env
UPSTASH_REDIS_REST_URL=CHANGE_ME
UPSTASH_REDIS_REST_TOKEN=CHANGE_ME
```

Không sao chép URL/token Redis từ Control Center khác.

## 4. Quyền GitHub

Token sử dụng bởi Control Center phải truy cập repository `nguyenvuhoang/w4s` với quyền tối thiểu:

- Actions: Read and write.
- Contents: Read-only.
- Metadata: Read-only.

Workflow `build-o24.yml` phải nhận input `service` cho đủ tám service W4S và push đúng image `vknighthub/w4s_o24<service>`.

## 5. Chuẩn bị từng server

Thực hiện riêng trên DEV, UAT và PROD:

```bash
sudo mkdir -p /opt/o24-deploy-agent/agent-data
sudo mkdir -p /app
sudo touch /app/.env.deploy
cd /opt/o24-deploy-agent
```

Copy từ `examples/w4s/server`:

```text
docker-compose.agent.yml
.env.agent.example
cloudflared-config.example.yml
```

Copy thêm hai tiện ích từ thư mục `scripts` của repository và giữ quyền thực thi:

```bash
sudo mkdir -p /opt/o24-deploy-agent/scripts
sudo install -m 0755 scripts/generate-secrets.sh /opt/o24-deploy-agent/scripts/generate-secrets.sh
sudo install -m 0755 scripts/capture-running-digest.sh /opt/o24-deploy-agent/scripts/capture-running-digest.sh
```

Các lệnh trên được chạy từ checkout của repository. Những bước còn lại được chạy trong
`/opt/o24-deploy-agent`.

Chọn đúng file theo môi trường và copy thành `agent-config.json`:

| Server | File nguồn |
|---|---|
| DEV | `agent-config.dev.example.json` |
| UAT | `agent-config.uat.example.json` |
| PROD | `agent-config.prod.example.json` |

Ví dụ:

```bash
sudo cp agent-config.uat.example.json agent-config.json
sudo cp .env.agent.example .env.agent
sudo chmod 600 .env.agent
```

Tạo API key/secret khác nhau cho từng môi trường:

```bash
./scripts/generate-secrets.sh
```

Điền kết quả vào `.env.agent` và điền đúng cùng cặp giá trị vào biến Vercel của môi trường tương ứng.

## 6. Chuyển Compose ứng dụng sang immutable digest

`examples/w4s/server/docker-compose.application.fragment.yml` chứa ánh xạ image cho tám service. Chỉ thay dòng `image` trong Compose đang chạy; giữ nguyên ports, volumes, networks và environment hiện có.

File `/app/.env.deploy` cần đủ tám biến:

```env
O24_WFO_IMAGE=vknighthub/w4s_o24wfo@sha256:REPLACE_WITH_RUNNING_DIGEST
O24_LOG_IMAGE=vknighthub/w4s_o24log@sha256:REPLACE_WITH_RUNNING_DIGEST
O24_CMS_IMAGE=vknighthub/w4s_o24cms@sha256:REPLACE_WITH_RUNNING_DIGEST
O24_CTH_IMAGE=vknighthub/w4s_o24cth@sha256:REPLACE_WITH_RUNNING_DIGEST
O24_W4S_IMAGE=vknighthub/w4s_o24w4s@sha256:REPLACE_WITH_RUNNING_DIGEST
O24_NCH_IMAGE=vknighthub/w4s_o24nch@sha256:REPLACE_WITH_RUNNING_DIGEST
O24_PMT_IMAGE=vknighthub/w4s_o24pmt@sha256:REPLACE_WITH_RUNNING_DIGEST
O24_AI_IMAGE=vknighthub/w4s_o24ai@sha256:REPLACE_WITH_RUNNING_DIGEST
```

Trước khi thay đổi container, chạy `/opt/o24-deploy-agent/scripts/capture-running-digest.sh`
để chụp digest thực tế đang chạy cho từng service. Không tự gán digest dựa trên tag
`latest`.

## 7. Khởi động Deploy Agent

```bash
cd /opt/o24-deploy-agent
sudo docker compose -f docker-compose.agent.yml config
sudo docker compose -f docker-compose.agent.yml pull
sudo docker compose -f docker-compose.agent.yml up -d
sudo docker logs --tail=100 o24-deploy-agent
```

Kiểm tra local:

```bash
curl -fsS http://127.0.0.1:9100/health
```

Sau đó cấu hình Cloudflare Tunnel từ file mẫu và kiểm tra hostname HTTPS từ bên ngoài server.

## 8. Cloudflare Access

Nếu bật Cloudflare Access cho agent, tạo một Service Token riêng cho W4S và đặt Client ID/Secret theo môi trường trong Vercel:

```env
DEV_CF_ACCESS_CLIENT_ID=CHANGE_ME
DEV_CF_ACCESS_CLIENT_SECRET=CHANGE_ME
UAT_CF_ACCESS_CLIENT_ID=CHANGE_ME
UAT_CF_ACCESS_CLIENT_SECRET=CHANGE_ME
PROD_CF_ACCESS_CLIENT_ID=CHANGE_ME
PROD_CF_ACCESS_CLIENT_SECRET=CHANGE_ME
```

Không public trực tiếp port `9100`; Compose mẫu chỉ bind `127.0.0.1:9100`.

## 9. Tạo người dùng W4S

Sau khi liên kết Redis riêng, chạy tại `apps/control-center` với biến môi trường của W4S:

```bash
pnpm seed:users
```

Tài khoản seed phải dùng mật khẩu tạm và `mustChangePassword=true`. Xác nhận lần đăng nhập đầu chuyển tới trang đổi mật khẩu.

## 10. Reconcile snapshots

Giữ Vercel cron hằng ngày theo `vercel.json`. Nếu cần đồng bộ mỗi 5 phút, cấu hình GitHub Actions gọi:

```text
https://release-w4s.vknight.io.vn/api/cron/reconcile-snapshots
```

Header:

```text
Authorization: Bearer <RECONCILE_CRON_SECRET>
```

Secret của workflow này phải trùng với W4S Vercel project và không dùng chung với hệ thống khác.

## 11. Smoke test

Trước khi promote, kiểm tra dashboard hiển thị đúng tám service ở cả DEV, UAT và PROD:

```text
WFO, LOG, CMS, CTH, W4S, NCH, PMT, AI
```

Với từng service:

1. Container status là running/healthy.
2. Image repository bắt đầu bằng `vknighthub/w4s_o24`.
3. Dashboard có immutable `repoDigest` dạng `@sha256:`.
4. Restart hoạt động và có audit log.
5. Xem log trả dữ liệu từ đúng container.
6. Không xuất hiện service ngoài catalog W4S.

Chạy thử một build tại DEV, đồng bộ registry, deploy digest mới và xác nhận container thực tế chạy đúng digest yêu cầu.

## 12. Promote và rollback

Quy trình chuẩn:

1. Build image một lần từ Control Center/GitHub Actions.
2. Deploy digest vào DEV.
3. Sau kiểm thử, promote đúng digest DEV → UAT.
4. Sau nghiệm thu, promote đúng digest UAT → PROD.
5. Nếu health check thất bại, agent tự rollback về image trước đó.
6. Có thể chọn release trước trong history để rollback thủ công.

Sau mỗi bước, so sánh `repoDigest` trên dashboard và digest từ `docker inspect`; hai giá trị phải giống nhau.

## 13. Kiểm tra cô lập cuối cùng

Chỉ đưa W4S vào sử dụng khi tất cả điều kiện sau đạt:

- Domain là `release-w4s.vknight.io.vn`.
- Redis, session secret, reconcile secret và tài khoản người dùng thuộc riêng W4S.
- Ba agent URL đều là hostname W4S đã chọn.
- Dashboard chỉ có tám service W4S.
- Mọi image đều dùng namespace `vknighthub/w4s_o24`.
- Audit log và release history ban đầu không chứa dữ liệu của dự án khác.
- Một thao tác tại W4S không tạo audit/release/operation ở Control Center khác.

## 14. Kiểm tra bộ cấu hình trước khi sử dụng

Từ root repository:

```bash
pnpm --dir apps/control-center validate:w4s-kit
```

Kết quả bắt buộc:

```text
DEV: 8 services valid
UAT: 8 services valid
PROD: 8 services valid
W4S deployment kit is valid
```
