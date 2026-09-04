# Integrators (dealer/installer accounts)

The layer above [households](households.md): an **integrator** is a
professional installer/dealer account that manages multiple client
households — the model most smart-home platforms sell through (installers
setting up and supporting systems for their own clients), rather than every
homeowner signing themselves up directly.

This is the foundation the setup-streamlining and billing work builds on.
Integrators use it through **`GET /dashboard`** — a browser page served
directly by the Worker (`cloudflare/src/dashboardUI.ts`), the same
no-install-required approach as the chat page (`GET /`). No `curl`, no
terminal: sign up or log in, add a household, get its access key, connect
its Home Assistant instance — all from a browser, including a phone's. The
API below is what that page calls; use it directly only for scripting or
troubleshooting.

## The model

```sql
CREATE TABLE integrators (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  password_hash TEXT NOT NULL,   -- PBKDF2-SHA256, see cloudflare/src/crypto.ts
  password_salt TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

A household gains `integrator_id` (nullable — `NULL` means not
integrator-managed, e.g. the bootstrap `default` household). One integrator
can own many households; a household belongs to at most one integrator.

Two genuinely different auth mechanisms now share this Worker:

| | Who | How | Used for |
|---|---|---|---|
| Household bearer token | A household's own client (Home Assistant integration, the chat page) | `Authorization: Bearer <api_key>` | `/chat`, `/admin/pin` |
| Integrator session | An integrator's dashboard | Signed, `HttpOnly` cookie | `/integrator/*` |

They're intentionally separate — a household's bearer token can't reach
`/integrator/*` routes, and an integrator's session cookie can't call
`/chat`. See `resolveHousehold()` vs `verifySessionCookie()` in
[`cloudflare/src/households.ts`](../cloudflare/src/households.ts) /
[`integrators.ts`](../cloudflare/src/integrators.ts).

## Sessions: signed cookie, not a sessions table

Logging in sets a cookie whose value is `integratorId.expiresAt.signature` —
HMAC-SHA256 signed with the `SESSION_SECRET` Worker secret, so it can't be
forged or tampered with, and *stateless*: verifying a session is pure
computation (no D1 read), and there's no sessions table to clean up.

The tradeoff: a session can't be revoked early short of rotating
`SESSION_SECRET`, which invalidates every integrator's session at once.
Fine for now; worth a real sessions table if per-session revocation (a "log
out this device" button) ever matters. See `createSessionCookie`/
`verifySessionCookie` in
[`cloudflare/src/integrators.ts`](../cloudflare/src/integrators.ts).

## API

All `/integrator/*` routes return JSON. Signup and login also set the
session cookie via `Set-Cookie` — from a browser, that's automatic; from
`curl`, use `-c cookies.txt -b cookies.txt` to capture and replay it.

### `POST /integrator/signup`

```json
{ "email": "installer@example.com", "password": "at least 8 characters", "name": "optional" }
```

`409` if the email's already registered.

### `POST /integrator/login`

```json
{ "email": "installer@example.com", "password": "..." }
```

`401` on any mismatch — deliberately the same response for "no such email"
and "wrong password," so a login attempt never reveals whether an email is
registered.

### `POST /integrator/logout`

No body. Clears the session cookie.

### `GET /integrator/households`

Session-authed. Returns `{ "households": [{ "id": "...", "name": "..." }, ...] }`
— every household belonging to the logged-in integrator.

### `POST /integrator/households`

Session-authed. `{ "name": "Customer name" }` →
`{ "household": { "id": "...", "name": "...", "api_key": "..." } }`.

`api_key` is shown here **once, in plaintext** — same as any generated
credential, there's no way to read it back later (it's not stored hashed
either — see [households.md](households.md), a known simplification worth
revisiting before this handles many customers' bearer tokens at real
scale). Hand it to the customer the same way described in
[households.md](households.md#adding-a-new-household).

### Managing a household's Home Assistant connection

#### `POST /integrator/households/:id/ha`

Session-authed, and the household must belong to the calling integrator
(checked — one integrator can't touch another's household by guessing its
id). `{ "url": "https://...", "token": "..." }`.

This is what replaces the old single global `HA_URL`/`HA_TOKEN` Worker
secrets for any integrator-managed household: each one connects to its own
Home Assistant instance. The token is encrypted at rest (AES-256-GCM, keyed
by the `ENCRYPTION_KEY` Worker secret — see
[`cloudflare.md`](cloudflare.md)), not just hashed, because `chat.ts`
genuinely needs it back in plaintext to call Home Assistant's API — unlike
a PIN or password, which only ever need to be checked, never read.

`500` if `ENCRYPTION_KEY` isn't configured on this Worker at all.

### Setting up a household's heat pump optimization

#### `POST /integrator/households/:id/energy`

Session-authed, same ownership check as the HA endpoint above.

```json
{
  "heatpump_entity_id": "climate.living_room_heat_pump",
  "room_temp_entity_id": "sensor.living_room_temperature",
  "min_temp_c": 18,
  "max_temp_c": 21,
  "postcode": "SW1A 1AA",
  "hvac_mode": "heat",
  "tariff_type": "octopus_agile",
  "octopus_region": "C"
}
```

`postcode` is a UK postcode — resolved server-side to a lat/long via
[postcodes.io](https://postcodes.io/) (free, no key) at save time, `400` if
it doesn't resolve. The response includes `resolved_postcode` in
postcodes.io's own normalized casing so you can confirm it matched.

`hvac_mode` is `"heat"` (default if omitted), `"cool"`, or `"auto"` — same
`climate.*` entity mechanism either way. `"heat"`/`"cool"` just flip which
direction the optimizer pushes toward (heat pump vs. air conditioning);
`"auto"` decides that itself each cycle from outdoor temperature, via
optional `auto_heat_below_c`/`auto_cool_above_c` (default 18/24) — see
[`energy.md`](energy.md#enabling-it). `tariff_type` is `"octopus_agile"`
(needs `octopus_region`) or `"manual"` (needs `manual_default_pence` and,
optionally, `manual_off_peak_windows`) — see
[`energy.md`](energy.md#enabling-it) for the full shape and why there are
two.

Technical setup for [heating optimization](energy.md) — this is the
*installer's* side of it (which entities, which tariff, which
comfort band), entirely separate from whether the household is actually
*paying* for the add-on, which the homeowner controls from their own
[billing portal](billing.md). Setting this doesn't start anything running
on its own; see `billing.md`'s Enforcement section for the full gate.

## What's not built yet

- **No way to remove/transfer a household**, rename one, or regenerate its
  `api_key` if it leaks — only create and list exist so far.
- **No integrator-side visibility into a household's billing status.**
  Billing is homeowner-direct, not integrator-managed — see
  [`billing.md`](billing.md) — so an integrator's dashboard has no view
  into whether their client's subscription is current.
- **No email verification or password reset.** Signup takes any
  syntactically-valid email at face value; a lost password has no recovery
  path today beyond a manual D1 update.
