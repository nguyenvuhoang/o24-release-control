# Deployment Notes

## Đường dẫn Compose

Agent chạy trong container nhưng gọi Docker daemon của host qua `/var/run/docker.sock`.

Thư mục ứng dụng nên được mount vào agent với **cùng đường dẫn tuyệt đối**:

```yaml
volumes:
  - /app:/app
```

Agent config:

```json
{
  "compose": {
    "projectDirectory": "/app",
    "files": ["/app/docker-compose.yml"],
    "baseEnvFile": "/app/.env",
    "deployEnvFile": "/app/.env.deploy"
  }
}
```

Việc dùng cùng đường dẫn giúp relative bind mount trong Compose được Docker daemon trên host resolve đúng.

`baseEnvFile` là file `.env` sẵn có của server (ports, hostname, secret khác...) — agent chỉ đọc gián tiếp qua Compose, **không bao giờ ghi**. `deployEnvFile` là file duy nhất agent ghi, chỉ chứa các key `*_IMAGE`. Agent luôn gọi Compose với `--env-file <baseEnvFile> --env-file <deployEnvFile>` theo đúng thứ tự đó, để deploy chỉ override đúng key image mà không làm mất cấu hình khác của server.

Nếu `deployEnvFile` chưa tồn tại trên host (lần deploy đầu tiên), agent tự tạo file rỗng khi khởi động — không cần tạo tay trước, không fail.

**Tương thích ngược:** config cũ chỉ có `"envFile": "/app/.env.deploy"` (không có `baseEnvFile`/`deployEnvFile`) vẫn chạy được — agent dùng `envFile` làm `deployEnvFile` và bỏ qua `--env-file` cho base (giữ đúng hành vi cũ, không merge `.env`). Nên migrate sang `baseEnvFile`/`deployEnvFile` sớm để không mất biến nền trong `.env`; khi cả hai đều có, `baseEnvFile`/`deployEnvFile` luôn được ưu tiên.

## Docker healthcheck

Nên khai báo cho mỗi API:

```yaml
healthcheck:
  test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/health"]
  interval: 10s
  timeout: 5s
  retries: 6
  start_period: 20s
```

Điều chỉnh command theo binary có trong image.

## Private Docker Hub

Docker daemon host phải đăng nhập trước:

```bash
docker login
```

Credential nằm trong Docker config của user chạy daemon. Agent gọi Docker Engine qua socket.

## Agent báo docker compose không tồn tại

Kiểm tra image agent:

```bash
docker exec o24-deploy-agent docker compose version
```

Rebuild image agent nếu Compose plugin chưa có.

## Deploy thất bại do permission `.env.deploy`

Agent container chạy root để có thể truy cập Docker socket. Kiểm tra mount và quyền:

```bash
docker exec o24-deploy-agent ls -la /app/.env.deploy
```

## Control Center báo signature invalid

Kiểm tra:

- API key giống nhau.
- API secret giống nhau.
- Đồng hồ server đồng bộ NTP.
- Cloudflare/proxy không thay đổi path.
- `baseUrl` không có path prefix khác với route agent.

## Container cùng dùng `latest`

Không lấy digest bằng cách inspect tag `latest` vì tag local có thể đã đổi. Luôn lấy image ID từ container trước:

```bash
IMAGE_ID=$(docker inspect --format '{{.Image}}' o24-wfo)
docker image inspect "$IMAGE_ID"
```

Script `capture-running-digest.sh` thực hiện đúng quy trình này.
