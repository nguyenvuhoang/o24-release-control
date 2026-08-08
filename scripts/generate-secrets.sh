#!/usr/bin/env sh
set -eu

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

printf 'SESSION_SECRET=%s\n' "$(random_hex 32)"
printf 'AGENT_API_KEY=%s\n' "$(random_hex 16)"
printf 'AGENT_API_SECRET=%s\n' "$(random_hex 32)"
