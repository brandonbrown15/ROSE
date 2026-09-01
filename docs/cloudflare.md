# Cloudflare Worker (ROSE Core)

Source lives in [`cloudflare/`](../cloudflare).

## One-time setup

```bash
cd cloudflare
npm install
npx wrangler login

# Create the D1 database, then paste the printed database_id into
# wrangler.jsonc under d1_databases[0].database_id
npx wrangler d1 create rose-db

# Create the Vectorize index used for semantic recall
npx wrangler vectorize create rose-memory --dimensions=1536 --metric=cosine

# Apply the schema
npm run db:migrate
```

`scripts/setup.sh` runs the above for you interactively.

## Secrets

Never put these in `wrangler.jsonc` or commit them — set them with
`wrangler secret put`:

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ROSE_API_KEY
# optional, only if the Worker should call back into Home Assistant:
npx wrangler secret put HA_URL
npx wrangler secret put HA_TOKEN
```

`ROSE_API_KEY` is the shared secret the Home Assistant integration sends as
`Authorization: Bearer <key>`. Generate one with `openssl rand -hex 32`.

## Local development

```bash
npm run dev
```

`wrangler dev` runs the Worker locally against local D1/Vectorize
emulation. Point the Home Assistant integration at the printed
`http://localhost:8787` URL while developing.

## Deploying

```bash
npm run deploy
```

### GitHub Actions deploys

`.github/workflows/deploy.yml` runs `wrangler deploy` on every push to `main`
that touches `cloudflare/`. It needs these repository secrets
(**Settings → Secrets and variables → Actions**):

- `CLOUDFLARE_API_TOKEN` — a token with Workers Scripts, D1, and Vectorize
  edit permissions
- `CLOUDFLARE_ACCOUNT_ID`

The Worker's own runtime secrets (`OPENAI_API_KEY`, `ROSE_API_KEY`, ...) are
set once via `wrangler secret put` as above — CI does not manage those.

## API

### `GET /health`

Unauthenticated. Returns `{"status": "ok"}`. Used by the Home Assistant
config flow to validate a connection.

### `POST /chat`

Requires `Authorization: Bearer <ROSE_API_KEY>`.

```json
{
  "conversation_id": "optional, omit to start a new conversation",
  "text": "what's on my calendar tomorrow?",
  "remember": false
}
```

Returns:

```json
{
  "conversation_id": "…",
  "reply": "…",
  "memories_used": 2
}
```

See [`memory.md`](memory.md) for what `remember` does and how recall works.
