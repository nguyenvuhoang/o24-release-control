#!/usr/bin/env bash
set -euo pipefail

REGISTRY_PREFIX="${REGISTRY_PREFIX:-vknighthub}"
VERSION="${VERSION:-1.0.0}"
PUSH="${PUSH:-false}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

build() {
  local image="$1"
  local context="$2"
  docker build -t "$image" "$context"
  if [[ "$PUSH" == "true" ]]; then
    docker push "$image"
  fi
}

build "$REGISTRY_PREFIX/o24-release-control:$VERSION" "$ROOT_DIR/apps/control-center"
build "$REGISTRY_PREFIX/o24-deploy-agent:$VERSION" "$ROOT_DIR/apps/deploy-agent"
