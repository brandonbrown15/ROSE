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
# shellcheck disable=SC1090
set -a && source "$ENV_FILE" && set +a

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
if grep -q "$DB_PLACEHOLDER" "$WRANGLER_CONFIG"; then
  echo "==> Creating D1 database 'rose-db'"
  D1_JSON="$(cd "$CF_DIR" && npx wrangler d1 create rose-db --json)"
  DB_ID="$(node -e "console.log(JSON.parse(process.argv[1]).database_id)" "$D1_JSON")"
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

# --- Optional: energy optimization (heat pump, solar, EV charging) ---------
# Off by default and skipped here unless you opt in — each piece below is
# independent (skip solar/EV if that hardware isn't installed yet; add it
# later by re-running this script). All need manual prerequisites (a public
# HA URL, API keys, entity IDs) that nothing can script for you. Read
# docs/energy.md before saying yes; this section just collects values and
# pushes them as secrets, it doesn't explain the safety model.
any_energy_configured=false

read -rp "Set up heat pump scheduling (Octopus Agile + Met Office) now? [y/N] " setup_heatpump
if [[ "$setup_heatpump" =~ ^[Yy]$ ]]; then
  echo "See docs/energy.md if you haven't read it yet — this needs a Home Assistant URL reachable from the internet."
  read -rp "  HA URL (e.g. your Cloudflare Tunnel or Nabu Casa URL): " ENERGY_HA_URL
  read -rsp "  HA long-lived access token (input hidden): " ENERGY_HA_TOKEN; echo
  read -rp "  Octopus Agile region letter (A-P): " ENERGY_OCTOPUS_REGION
  read -rsp "  Met Office DataHub API key (input hidden): " ENERGY_MET_OFFICE_API_KEY; echo
  read -rp "  Site latitude (for the weather forecast): " ENERGY_MET_OFFICE_LAT
  read -rp "  Site longitude: " ENERGY_MET_OFFICE_LON
  read -rp "  Heat pump climate entity ID (e.g. climate.living_room_heat_pump): " ENERGY_HEATPUMP_ENTITY
  read -rp "  Room temperature sensor entity ID (e.g. sensor.living_room_temperature): " ENERGY_ROOM_TEMP_ENTITY
  read -rp "  Minimum comfort temperature, °C: " ENERGY_MIN_TEMP
  read -rp "  Maximum comfort temperature, °C: " ENERGY_MAX_TEMP

  (cd "$CF_DIR" && printf '%s' "$ENERGY_HA_URL" | npx wrangler secret put HA_URL)
  (cd "$CF_DIR" && printf '%s' "$ENERGY_HA_TOKEN" | npx wrangler secret put HA_TOKEN)
  (cd "$CF_DIR" && printf '%s' "$ENERGY_OCTOPUS_REGION" | npx wrangler secret put OCTOPUS_REGION)
  (cd "$CF_DIR" && printf '%s' "$ENERGY_MET_OFFICE_API_KEY" | npx wrangler secret put MET_OFFICE_API_KEY)
  (cd "$CF_DIR" && printf '%s' "$ENERGY_MET_OFFICE_LAT" | npx wrangler secret put MET_OFFICE_LATITUDE)
  (cd "$CF_DIR" && printf '%s' "$ENERGY_MET_OFFICE_LON" | npx wrangler secret put MET_OFFICE_LONGITUDE)
  (cd "$CF_DIR" && printf '%s' "$ENERGY_HEATPUMP_ENTITY" | npx wrangler secret put ROSE_HEATPUMP_ENTITY_ID)
  (cd "$CF_DIR" && printf '%s' "$ENERGY_ROOM_TEMP_ENTITY" | npx wrangler secret put ROSE_ROOM_TEMP_ENTITY_ID)
  (cd "$CF_DIR" && printf '%s' "$ENERGY_MIN_TEMP" | npx wrangler secret put ROSE_HEATING_MIN_TEMP)
  (cd "$CF_DIR" && printf '%s' "$ENERGY_MAX_TEMP" | npx wrangler secret put ROSE_HEATING_MAX_TEMP)
  any_energy_configured=true
  echo "==> Heat pump scheduling configured."
else
  echo "Skipped heat pump scheduling — set it up later any time by re-running this script."
fi

read -rp "Set up solar surplus tracking (SolarEdge) now? [y/N] (skip if not installed yet) " setup_solar
if [[ "$setup_solar" =~ ^[Yy]$ ]]; then
  read -rsp "  SolarEdge Monitoring API key (input hidden): " ENERGY_SOLAREDGE_KEY; echo
  read -rp "  SolarEdge site ID: " ENERGY_SOLAREDGE_SITE

  (cd "$CF_DIR" && printf '%s' "$ENERGY_SOLAREDGE_KEY" | npx wrangler secret put SOLAREDGE_API_KEY)
  (cd "$CF_DIR" && printf '%s' "$ENERGY_SOLAREDGE_SITE" | npx wrangler secret put SOLAREDGE_SITE_ID)
  any_energy_configured=true
  echo "==> Solar surplus tracking configured."

  read -rp "  Also set up EV charging (solar-surplus-first) now? [y/N] (needs an HA integration for the charger already installed) " setup_ev
  if [[ "$setup_ev" =~ ^[Yy]$ ]]; then
    echo "  See 'EV charger control' in docs/energy.md — this calls a Home Assistant service, not SolarEdge directly."
    read -rp "    EV charger entity ID: " ENERGY_EV_ENTITY
    read -rp "    Start service (domain.service, e.g. switch.turn_on): " ENERGY_EV_START
    read -rp "    Stop service (domain.service, e.g. switch.turn_off): " ENERGY_EV_STOP
    read -rp "    Minimum solar surplus to start charging, kW [1.4]: " ENERGY_EV_THRESHOLD
    ENERGY_EV_THRESHOLD="${ENERGY_EV_THRESHOLD:-1.4}"

    (cd "$CF_DIR" && printf '%s' "$ENERGY_EV_ENTITY" | npx wrangler secret put ROSE_EV_CHARGER_ENTITY_ID)
    (cd "$CF_DIR" && printf '%s' "$ENERGY_EV_START" | npx wrangler secret put ROSE_EV_CHARGER_START_SERVICE)
    (cd "$CF_DIR" && printf '%s' "$ENERGY_EV_STOP" | npx wrangler secret put ROSE_EV_CHARGER_STOP_SERVICE)
    (cd "$CF_DIR" && printf '%s' "$ENERGY_EV_THRESHOLD" | npx wrangler secret put ROSE_EV_CHARGER_SURPLUS_THRESHOLD_KW)
    echo "==> EV charging configured."
  fi
else
  echo "Skipped solar/EV — add them later any time by re-running this script."
fi

if [ "$any_energy_configured" = true ]; then
  (cd "$CF_DIR" && printf 'true' | npx wrangler secret put ENERGY_OPTIMIZATION_ENABLED)
  echo "==> Energy optimization enabled. Test it now before trusting the schedule:"
  echo "      curl -X POST <your-worker-url>/energy/run -H \"Authorization: Bearer $ROSE_API_KEY\""
  echo "    See 'Testing before you trust it' in docs/energy.md."
fi
