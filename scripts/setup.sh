#!/usr/bin/env bash
# ROSE bootstrap: install Worker dependencies and create the Cloudflare
# resources (D1 database, Vectorize index) ROSE needs. Safe to re-run.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CF_DIR="$ROOT_DIR/cloudflare"

echo "==> ROSE setup"

if [ ! -f "$ROOT_DIR/.env" ]; then
  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
  echo "Created .env from .env.example — fill in your secrets before deploying."
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required (https://nodejs.org/). Install it and re-run this script." >&2
  exit 1
fi

echo "==> Installing Worker dependencies"
(cd "$CF_DIR" && npm install)

echo "==> Cloudflare login (skip if already logged in)"
(cd "$CF_DIR" && npx wrangler whoami >/dev/null 2>&1) || (cd "$CF_DIR" && npx wrangler login)

read -rp "Create the D1 database 'rose-db' now? [y/N] " create_d1
if [[ "$create_d1" =~ ^[Yy]$ ]]; then
  (cd "$CF_DIR" && npx wrangler d1 create rose-db)
  echo "Copy the database_id printed above into cloudflare/wrangler.jsonc (d1_databases[0].database_id)."
fi

read -rp "Create the Vectorize index 'rose-memory' now? [y/N] " create_vec
if [[ "$create_vec" =~ ^[Yy]$ ]]; then
  (cd "$CF_DIR" && npx wrangler vectorize create rose-memory --dimensions=1536 --metric=cosine)
fi

read -rp "Apply D1 migrations now? (only after setting database_id above) [y/N] " run_migrations
if [[ "$run_migrations" =~ ^[Yy]$ ]]; then
  (cd "$CF_DIR" && npm run db:migrate)
fi

cat <<'EOF'

==> Next steps
  1. Set your Worker secrets:
       cd cloudflare
       npx wrangler secret put OPENAI_API_KEY
       npx wrangler secret put ROSE_API_KEY
  2. Deploy: ./scripts/deploy.sh
  3. Install the Home Assistant integration — see docs/home-assistant.md

EOF
