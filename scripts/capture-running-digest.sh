#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${1:-}"
REPOSITORY="${2:-}"
ENV_KEY="${3:-}"
ENV_FILE="${4:-/app/.env.deploy}"

if [[ -z "$CONTAINER" || -z "$REPOSITORY" || -z "$ENV_KEY" ]]; then
  echo "Usage: $0 <container-name> <image-repository> <env-key> [env-file]" >&2
  echo "Example: $0 o24-wfo vknighthub/ips_o24wfo O24_WFO_IMAGE /app/.env.deploy" >&2
  exit 1
fi

IMAGE_ID="$(docker inspect --format '{{.Image}}' "$CONTAINER")"
DIGEST_REF="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$IMAGE_ID" | grep -F "${REPOSITORY}@sha256:" | head -n 1 || true)"

if [[ -z "$DIGEST_REF" ]]; then
  echo "Cannot find RepoDigest for $REPOSITORY from container $CONTAINER." >&2
  echo "Pull the current image once, then retry." >&2
  exit 2
fi

mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
cp "$ENV_FILE" "${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"

TMP_FILE="$(mktemp)"
awk -v key="$ENV_KEY" -v value="$DIGEST_REF" '
BEGIN { found=0 }
$0 ~ "^" key "=" { print key "=" value; found=1; next }
{ print }
END { if (!found) print key "=" value }
' "$ENV_FILE" > "$TMP_FILE"
install -m 640 "$TMP_FILE" "$ENV_FILE"
rm -f "$TMP_FILE"

printf '%s=%s\n' "$ENV_KEY" "$DIGEST_REF"
echo "Saved to $ENV_FILE"
