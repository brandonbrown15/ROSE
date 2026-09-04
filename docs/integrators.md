# Integrators (dealer/installer accounts)

The layer above [households](households.md): an **integrator** is a
professional installer/dealer account that manages multiple client
households — the model most smart-home platforms sell through (installers
setting up and supporting systems for their own clients), rather than every
homeowner signing themselves up directly.

This is the foundation the setup-streamlining and billing work builds on.
As of this doc, it's an API only — see [What's not built yet](#whats-not-built-yet)
for the dashboard page that actually uses it.

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

## What's not built yet

- **No dashboard page.** Everything above is a JSON API; there's no `GET
  /integrator` (or similar) page that actually calls it yet — a browser UI
  is the natural next step once this foundation is confirmed working.
- **No way to remove/transfer a household**, rename one, or regenerate its
  `api_key` if it leaks — only create and list exist so far.
- **No billing.** Integrator accounts and household ownership are the
  foundation billing will attach to (a subscription per household, most
  likely) — not built yet.
- **No email verification or password reset.** Signup takes any
  syntactically-valid email at face value; a lost password has no recovery
  path today beyond a manual D1 update.
