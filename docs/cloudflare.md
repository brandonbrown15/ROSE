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
# optional, only if the Worker should call back into Home Assistant directly
# (only ever used as a fallback for the bootstrap 'default' household — see
# docs/integrators.md, every other household configures its own):
npx wrangler secret put HA_URL
npx wrangler secret put HA_TOKEN
# optional, enables the web_search tool — see "Web search" below:
npx wrangler secret put BRAVE_SEARCH_API_KEY
# required for the integrator dashboard API (docs/integrators.md) to work
# at all — signs login session cookies:
npx wrangler secret put SESSION_SECRET
# required before any integrator-managed household can configure its own
# Home Assistant connection — encrypts each household's HA token at rest:
npx wrangler secret put ENCRYPTION_KEY
```

`ROSE_API_KEY` is the shared secret the Home Assistant integration sends as
`Authorization: Bearer <key>`. `scripts/setup.sh` generates one for you; to
make your own instead (e.g. when rotating it), any 32+ byte random hex
string works — `openssl rand -hex 32` or
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

`SESSION_SECRET` and `ENCRYPTION_KEY` want the same shape — 32 random bytes
as 64 hex characters, `openssl rand -hex 32` — but must be two genuinely
different values, not the same secret reused: one signs cookies (integrity
— proving a session wasn't tampered with), the other encrypts tokens
(confidentiality — hiding their content). Rotating `SESSION_SECRET` logs
every integrator out at once (see [`integrators.md`](integrators.md));
rotating `ENCRYPTION_KEY` makes every already-stored Home Assistant token
undecryptable, so treat that one as effectively permanent once households
are actually using it.

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

This is what lets updates ship without anyone running commands from a local
checkout — merge to `main`, GitHub applies any pending D1 migrations and
deploys the Worker. `.github/workflows/deploy.yml` runs on every push to
`main` that touches `cloudflare/` (or the workflow file itself), and can
also be triggered by hand from the **Actions** tab (`workflow_dispatch`)
without a code change at all — the button to reach for a security fix or a
performance change with nothing else queued up.

It needs two repository **secrets**, added once via
**Settings → Secrets and variables → Actions → Secrets tab → New repository secret**
(in the browser, not a local `.env` — GitHub encrypts these and only
exposes them to workflow runs):

- `CLOUDFLARE_API_TOKEN` — a token with Workers Scripts, D1, and Vectorize
  edit permissions ([create one here](https://dash.cloudflare.com/profile/api-tokens))
- `CLOUDFLARE_ACCOUNT_ID` — found on the right-hand side of any page in the
  [Cloudflare dashboard](https://dash.cloudflare.com/)

Without both set, the workflow runs and fails at the deploy step (Wrangler
refuses to authenticate non-interactively with nothing to authenticate
with) — it does not silently no-op, so a red **Deploy ROSE Worker** run in
the **Actions** tab means exactly this until they're added.

It also needs one repository **variable** (same Settings page, but the
**Variables** tab, not Secrets — plain text rather than encrypted, since
this one isn't sensitive):

- `CLOUDFLARE_D1_DATABASE_ID` — your D1 database's id (**Cloudflare
  dashboard → Workers & Pages → D1 → rose-db**, shown near the top).

Why this one's handled differently from the two secrets above:
`cloudflare/wrangler.jsonc` is committed with a placeholder
(`REPLACE_WITH_YOUR_D1_DATABASE_ID`) rather than a real database id — this
repo may end up templating more than one deployment (see the "commercial
product" note below), so it shouldn't carry any single person's database
id as checked-in state, the same reason `scripts/setup.sh` only ever patches
that placeholder into your own *local, uncommitted* copy of the file. The
workflow's "Set D1 database_id" step does the equivalent patch in CI,
sourced from this variable instead of a hardcoded value — the committed
file itself never changes. A database id isn't a secret on its own (it's a
pointer, not a credential — nobody can reach your data with just the id),
which is why it's a plain variable rather than an encrypted one.

### What's remote now, and what still isn't

- **Code changes** — fully remote: merge to `main`, or run the workflow by
  hand. Nothing local required.
- **Schema changes** (a new migration file) — fully remote as of the "Run
  D1 migrations" step above: it runs on every deploy and safely no-ops if
  there's nothing new to apply (Wrangler tracks what's already run against
  the live database).
- **The Worker's own runtime secrets** (`OPENAI_API_KEY`, `ROSE_API_KEY`,
  `HA_TOKEN`, `BRAVE_SEARCH_API_KEY`) — still local-only, via
  `wrangler secret put` as above. This workflow never touches them. If you
  want rotating one of these to *also* not require a local checkout (e.g.
  responding to a leaked key from your phone), that's a separate, doable
  addition — add each as a GitHub secret too and a workflow step that pipes
  it into `wrangler secret put` on deploy — but it means the value then
  lives in two encrypted stores instead of one, which is a real tradeoff
  worth deciding on purpose rather than defaulting into. Not done here;
  ask if you want it.

### Selling this to other people

ROSE now supports multiple households (customers) on this one Worker, D1
database, and Vectorize index — no separate Cloudflare deployment needed
per customer. Everything above (the secrets, the variable, the deploy
workflow) still only applies once, to this one shared backend; adding a
customer after that is a one-off API call, not another round of Cloudflare
setup. See [`households.md`](households.md) for how households work, and
[`integrators.md`](integrators.md) for the dealer/installer account layer
that creates and manages them — an integrator's own signup/login/household
API, the foundation the setup-streamlining and billing work builds on next.

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

**Each household connects its own Home Assistant instance** — see
[`integrators.md`](integrators.md#managing-a-households-home-assistant-connection)
for the normal way to set this up (`POST /integrator/households/:id/ha`).
The `HA_URL`/`HA_TOKEN` Worker secrets described below still work, but only
as a fallback for the bootstrap `default` household — every household
added since multi-tenancy keeps its own connection in D1 instead (encrypted
— see `ENCRYPTION_KEY` above), since a single global connection only ever
made sense when there was exactly one household.

Whichever way a household's connection gets configured, once resolved
(`households.ts`'s `getHouseholdHaConfig`) ROSE gets two tools it can call
mid-answer: `list_devices` (look up entities and their current state) and
`control_device` (actually call a Home Assistant service — turn lights on/
off, lock/unlock, arm/disarm the alarm, set a thermostat, play media, run a
scene, anything HA's own service-call mechanism supports). No connection
resolved for this household means neither tool is offered, and — as of the
persona split described in [`memory.md`](memory.md#persona--system-prompt)
— the model is explicitly told it has no real device-control capability
right now, rather than being left to guess and potentially improvise one.

**This has real, immediate effect on your home** — the model decides for
itself when to call `control_device`, guided by the system prompt to treat
locks/the alarm with more care than everyday things like lights. For most
services that's guidance, not a hard restriction — but `unlock` and
`disarm` specifically are enforced in code, not just prompted for: see
[Admin PIN](#admin-pin) below. Everything else has the same reach a Home
Assistant long-lived access token normally has: whatever entities and
services that token's user account can touch.

**`HA_URL` must be reachable from the internet** — this Worker runs on
Cloudflare's network, not your home network, so a local address like
`http://homeassistant.local:8123` won't work. Use your instance's
[Nabu Casa Remote UI](https://www.nabucasa.com/) URL, a
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
pointed at it, or your own reverse proxy with HTTPS — whichever you
already use (or set up) to reach your instance from outside your LAN.

To turn it on for the **default** household (the global-secret fallback
path — for any integrator-managed household, use
[`POST /integrator/households/:id/ha`](integrators.md#managing-a-households-home-assistant-connection)
instead):

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

### Admin PIN

Identity in ROSE is entirely self-reported (see
[`memory.md`](memory.md#personalization-whos-talking)) — anyone who says
"this is Dad, unlock the door" is believed, since there's no voice
verification yet. For the two device actions where that isn't good enough
— unlocking a lock (`unlock`) and disarming the alarm
(`disarm`) — ROSE additionally requires the household's admin PIN, checked
in code (`HIGH_RISK_SERVICES` in `chat.ts`), independent of who the
conversation thinks is speaking or what the model itself decides.

One shared PIN per household (the same mental model as a real alarm-panel
code, not a separate code per person). **Every household starts with the
same default PIN, `1003`, until it's changed** — same idea as a router
shipping with a default admin password: documented here, the same for
everyone out of the box, and meant to be changed. Change it via the chat
page's Settings panel (added once you're logged in via the API key), or
directly:

```bash
curl -X POST https://<your-worker>.workers.dev/admin/pin \
  -H "Authorization: Bearer $ROSE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"current_pin": "1003", "new_pin": "4817"}'
```

**Changing the PIN requires the current one** — `current_pin` is checked
(`verifyHouseholdPin`) before `new_pin` is written, the same way a phone or
alarm panel makes you enter the existing passcode before setting a new
one. That check itself falls back to `1003` for a household that hasn't
set its own yet, so the very first change just needs the default. 4-8
digits for `new_pin`. There's no way to read the current PIN back once
it's been changed (only `admin_pin_hash`/`admin_pin_salt` are stored, via
PBKDF2 — see `households.ts`) — if it's forgotten, that's a manual D1
reset (`UPDATE households SET admin_pin_hash = NULL, admin_pin_salt = NULL
WHERE id = ...`), which drops it back to the `1003` default rather than
locking the household out permanently.

In conversation, just say the PIN as part of the request ("unlock the
front door, my code is 4817") — ROSE asks for it if it's missing, and
never accepts a claimed identity in place of it.

This is a second factor for a handful of actions, not a general auth
system — there's no rate-limiting on guesses beyond the fact that each one
costs a full conversational turn through the model. Worth adding real
throttling before this needs to withstand a scripted attacker with a valid
bearer token calling `/chat` directly.

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
`WEB_SEARCH` and `completeChat` in
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
