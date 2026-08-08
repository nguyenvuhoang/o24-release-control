#!/usr/bin/env bash
set -euo pipefail

SOURCE_IMAGE="${1:-}"
TARGET_TAG="${2:-}"

if [[ -z "$SOURCE_IMAGE" || -z "$TARGET_TAG" ]]; then
  echo "Usage: $0 <repository@sha256:digest|repository:tag> <repository:target-tag>" >&2
  exit 1
fi

docker buildx imagetools create -t "$TARGET_TAG" "$SOURCE_IMAGE"
docker buildx imagetools inspect "$TARGET_TAG"
