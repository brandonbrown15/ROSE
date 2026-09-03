# Cloudflare Worker (ROSE Core)

Source lives in [`cloudflare/`](../cloudflare).

## One-time setup

`./scripts/setup.sh` (from the repo root) does all of this for you —
installs dependencies, logs into Cloudflare, creates the D1 database and
patches its id into `wrangler.jsonc` automatically, creates the Vectorize
index, and applies the schema. The manual equivalent, if you want to run it
yourself (e.g. to reuse an existing D1 database):

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

## Secrets

`scripts/setup.sh` sets `OPENAI_API_KEY` and `ROSE_API_KEY` for you (the
latter it generates itself). `HA_URL`/`HA_TOKEN`/`BRAVE_SEARCH_API_KEY` are
optional and not set by either script — add them by hand if you want them.
Never put any of these in `wrangler.jsonc` or commit them — set them with
`wrangler secret put`:

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ROSE_API_KEY
# optional, only if the Worker should call back into Home Assistant:
npx wrangler secret put HA_URL
npx wrangler secret put HA_TOKEN
# optional, enables the web_search tool — see "Web search" below:
npx wrangler secret put BRAVE_SEARCH_API_KEY
```

`ROSE_API_KEY` is the shared secret the Home Assistant integration sends as
`Authorization: Bearer <key>`. `scripts/setup.sh` generates one for you; to
make your own instead (e.g. when rotating it), any 32+ byte random hex
string works — `openssl rand -hex 32` or
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

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

### `GET /`

Unauthenticated. Serves a small standalone chat page (embedded in the
Worker, no separate hosting needed) so you can demo ROSE from any browser —
open the Worker's own URL on a phone, tablet, or laptop, paste in your
`ROSE_API_KEY` when prompted, and start chatting. Useful for showing ROSE
to someone without Home Assistant running. The key is stored only in that
browser's `localStorage` and used solely to call `/chat` directly from the
page — it never touches anything but this Worker.

### `GET /health`

Unauthenticated. Returns `{"status": "ok"}`. Used by the Home Assistant
config flow to validate a connection.

### `POST /chat`

Requires `Authorization: Bearer <ROSE_API_KEY>`.

```json
{
  "conversation_id": "optional, omit to start a new conversation",
  "text": "what's on my calendar tomorrow?",
  "remember": null
}
```

`remember` is optional and normally omitted entirely — ROSE decides on its
own whether the exchange is worth storing long-term. Pass `true`/`false` only
to override that decision for one request. See [`memory.md`](memory.md).

Returns:

```json
{
  "conversation_id": "…",
  "reply": "…",
  "memories_used": 2
}
```

`memories_used` counts how many recalled memories were fed into the reply —
it doesn't reflect whether this exchange itself got remembered (that
decision happens after the reply, in the background). See
[`memory.md`](memory.md) for the full flow.

### Home Assistant device control

When both `HA_URL` and `HA_TOKEN` are set, ROSE gets two tools it can call
mid-answer: `list_devices` (look up entities and their current state) and
`control_device` (actually call a Home Assistant service — turn lights on/
off, lock/unlock, arm/disarm the alarm, set a thermostat, play media, run a
scene, anything HA's own service-call mechanism supports). Without both set,
neither tool is offered and ROSE stays conversation-only, same as before
this existed.

**This has real, immediate effect on your home** — the model decides for
itself when to call `control_device`, guided by the system prompt to treat
locks/the alarm with more care than everyday things like lights, but that's
guidance, not a hard restriction. It has the same reach a Home Assistant
long-lived access token normally has: whatever entities and services that
token's user account can touch.

**`HA_URL` must be reachable from the internet** — this Worker runs on
Cloudflare's network, not your home network, so a local address like
`http://homeassistant.local:8123` won't work. Use your instance's
[Nabu Casa Remote UI](https://www.nabucasa.com/) URL, a
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
pointed at it, or your own reverse proxy with HTTPS — whichever you
already use (or set up) to reach your instance from outside your LAN.

To turn it on:

1. In Home Assistant: **Profile → Security → Long-lived access tokens →
   Create token**. Copy it — HA only shows it once.
2. `npx wrangler secret put HA_URL` — your instance's public URL, no
   trailing slash.
3. `npx wrangler secret put HA_TOKEN` — paste the token from step 1.
4. Redeploy (`npm run deploy`).

See `LIST_DEVICES`/`CONTROL_DEVICE` in
[`cloudflare/src/chat.ts`](../cloudflare/src/chat.ts) for the tool
definitions, and [`homeAssistant.ts`](../cloudflare/src/homeAssistant.ts)
for the actual `/api/states` and `/api/services/...` calls.

### Web search

ROSE can look things up on the open web — news, current events, anything
time-sensitive or outside what the model already knows — via a `web_search`
tool it can call mid-answer, backed by the
[Brave Search API](https://api.search.brave.com/). This is entirely
optional: without `BRAVE_SEARCH_API_KEY` set, the tool simply isn't offered
to the model, and ROSE answers from what it already knows, same as before
this existed. Nothing else changes either way.

To turn it on:

1. Sign up at [api.search.brave.com](https://api.search.brave.com/) and grab
   an API key (there's a free tier).
2. `npx wrangler secret put BRAVE_SEARCH_API_KEY` and paste it in.
3. Redeploy (`npm run deploy`).

The model decides on its own, per message, whether a question actually
needs a live search — it won't search for things it already knows. See
`WEB_SEARCH_TOOL` and `completeChat` in
[`cloudflare/src/chat.ts`](../cloudflare/src/chat.ts) for how the tool-call
loop works, and [`search.ts`](../cloudflare/src/search.ts) for the Brave API
call itself.

### CORS

Every response carries permissive CORS headers (`access-control-allow-origin: *`),
so a browser-based client — a standalone chat page, a personal dashboard —
can call this API directly, not just server-side clients like the Home
Assistant integration. This doesn't weaken anything: the API is still
gated by the same `Authorization: Bearer <ROSE_API_KEY>` check regardless
of where the request comes from. CORS only controls which *websites'*
JavaScript is allowed to read the response — it has no bearing on
authentication.
