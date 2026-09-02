#!/usr/bin/env bash
# ROSE bootstrap: from a fresh clone to a deployed Worker in one command.
# Installs dependencies, creates the Cloudflare resources ROSE needs (D1,
# Vectorize), patches wrangler.jsonc with the new database id, applies the
# schema, generates a ROSE_API_KEY if you don't have one, and offers to
# deploy at the end. Safe to re-run — every step is skipped if already done.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CF_DIR="$ROOT_DIR/cloudflare"
ENV_FILE="$ROOT_DIR/.env"
WRANGLER_CONFIG="$CF_DIR/wrangler.jsonc"
DB_PLACEHOLDER="REPLACE_WITH_YOUR_D1_DATABASE_ID"

echo "==> ROSE setup"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required (https://nodejs.org/). Install it and re-run this script." >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  cp "$ROOT_DIR/.env.example" "$ENV_FILE"
fi

# .env should only fill in values that aren't already set in the shell —
# never clobber something the caller explicitly exported (e.g. someone
# running with CLOUDFLARE_API_TOKEN set for a non-interactive wrangler
# session, since .env.example ships that key blank for local/interactive
# use). Plain `source` doesn't respect that on its own, so preserve
# whatever's already set and restore it after.
ENV_KEYS="OPENAI_API_KEY ROSE_API_KEY HA_URL HA_TOKEN CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID"
for key in $ENV_KEYS; do
  declare "PRESERVED_$key=${!key:-}"
done

# shellcheck disable=SC1090
set -a && source "$ENV_FILE" && set +a

for key in $ENV_KEYS; do
  preserved_var="PRESERVED_$key"
  if [ -n "${!preserved_var}" ]; then
    export "$key=${!preserved_var}"
  fi
done

# --- OPENAI_API_KEY: the one thing we genuinely can't generate for you ----
if [ -z "${OPENAI_API_KEY:-}" ]; then
  read -rsp "Paste your OpenAI API key (input hidden): " OPENAI_API_KEY
  echo
  if [ -z "$OPENAI_API_KEY" ]; then
    echo "An OpenAI API key is required. Get one at https://platform.openai.com/api-keys and re-run this script." >&2
    exit 1
  fi
  sed -i.bak "s|^OPENAI_API_KEY=.*|OPENAI_API_KEY=$OPENAI_API_KEY|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
fi

# --- ROSE_API_KEY: generate one so nobody has to run anything by hand -----
# (uses node, not openssl — node is already a hard prerequisite, so this
# keeps "just Node.js" the whole toolchain story)
if [ -z "${ROSE_API_KEY:-}" ]; then
  ROSE_API_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  sed -i.bak "s|^ROSE_API_KEY=.*|ROSE_API_KEY=$ROSE_API_KEY|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  echo "Generated ROSE_API_KEY and saved it to .env — you'll enter this in Home Assistant later."
fi

echo "==> Installing Worker dependencies"
(cd "$CF_DIR" && npm install --no-fund --no-audit)

echo "==> Cloudflare login (skip if already logged in)"
(cd "$CF_DIR" && npx wrangler whoami >/dev/null 2>&1) || (cd "$CF_DIR" && npx wrangler login)

# --- D1 database: create it and patch wrangler.jsonc automatically --------
# `d1 create --json` isn't supported by every wrangler version (it errors
# with "Unknown argument: json" on some), so this runs plain `d1 create` and
# pulls the id out of its output by shape (a UUID) rather than depending on
# either the TOML-style `database_id = "..."` or JSON-style `"database_id":
# "..."` framing — both have shown up across wrangler versions, and the
# UUID itself is the only thing guaranteed present either way.
if grep -q "$DB_PLACEHOLDER" "$WRANGLER_CONFIG"; then
  echo "==> Creating D1 database 'rose-db'"
  D1_OUTPUT="$(cd "$CF_DIR" && npx wrangler d1 create rose-db)"
  echo "$D1_OUTPUT"
  DB_ID="$(echo "$D1_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)"
  if [ -z "$DB_ID" ]; then
    echo "Couldn't find database_id in wrangler's output above. Copy it" >&2
    echo "manually into $WRANGLER_CONFIG (replacing $DB_PLACEHOLDER) and re-run this script." >&2
    exit 1
  fi
  sed -i.bak "s|$DB_PLACEHOLDER|$DB_ID|" "$WRANGLER_CONFIG" && rm -f "$WRANGLER_CONFIG.bak"
  echo "Set database_id=$DB_ID in wrangler.jsonc"
else
  echo "==> D1 database already configured in wrangler.jsonc, skipping"
fi

# --- Vectorize index: idempotent, ignore "already exists" ------------------
echo "==> Creating Vectorize index 'rose-memory' (skipping if it already exists)"
(cd "$CF_DIR" && npx wrangler vectorize create rose-memory --dimensions=1536 --metric=cosine) \
  || echo "  (already exists, or creation failed — check above if this is unexpected)"

echo "==> Applying D1 migrations"
(cd "$CF_DIR" && npm run db:migrate)

echo "==> Setting Worker secrets"
(cd "$CF_DIR" && printf '%s' "$OPENAI_API_KEY" | npx wrangler secret put OPENAI_API_KEY)
(cd "$CF_DIR" && printf '%s' "$ROSE_API_KEY" | npx wrangler secret put ROSE_API_KEY)

echo "==> Deploying"
(cd "$CF_DIR" && npm run deploy)

cat <<EOF

==> Done. Copy these into Home Assistant (Settings → Devices & services →
    Add Integration → ROSE):

      ROSE URL : the *.workers.dev URL printed above
      API Key  : $ROSE_API_KEY

    See docs/home-assistant.md for the integration install steps.

EOF
