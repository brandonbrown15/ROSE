#!/usr/bin/env bash
# Redeploy the ROSE Cloudflare Worker after code or secret changes.
# `scripts/setup.sh` already does this once as part of first-time setup —
# use this script for subsequent deploys. Pushes secrets from .env (if
# present) and runs `wrangler deploy`. CI uses .github/workflows/deploy.yml
# instead for pushes to main.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CF_DIR="$ROOT_DIR/cloudflare"

if [ -f "$ROOT_DIR/.env" ]; then
  # shellcheck disable=SC1091
  set -a && source "$ROOT_DIR/.env" && set +a
fi

echo "==> Pushing secrets"
for secret in OPENAI_API_KEY ROSE_API_KEY; do
  value="${!secret:-}"
  if [ -n "$value" ]; then
    (cd "$CF_DIR" && printf '%s' "$value" | npx wrangler secret put "$secret")
  else
    echo "Skipping $secret (not set in .env)"
  fi
done

# HA_URL / HA_TOKEN are optional — only needed if the Worker calls back
# into Home Assistant.
for secret in HA_URL HA_TOKEN; do
  value="${!secret:-}"
  if [ -n "$value" ]; then
    (cd "$CF_DIR" && printf '%s' "$value" | npx wrangler secret put "$secret")
  fi
done

echo "==> Deploying Worker"
(cd "$CF_DIR" && npm run deploy)
