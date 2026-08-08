# Security

Deploy Agent được mount Docker socket và có quyền quản trị Docker host. Chỉ triển khai agent trên server tin cậy.

- Không expose agent trực tiếp ra Internet.
- Dùng Cloudflare Access, VPN hoặc private network.
- Không dùng chung secret giữa DEV, UAT và PROD.
- Không commit `.env`, `.env.agent`, `environments.json` có secret hoặc `agent-data`.
- Không mở rộng agent bằng API thực thi command tùy ý.
- Luôn dùng image digest khi deploy.
