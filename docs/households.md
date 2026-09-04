# Households (multi-tenancy)

ROSE runs as a single shared backend that can serve more than one
household — a customer, in commercial terms — from one Worker, one D1
database, and one Vectorize index, instead of a separate Cloudflare
deployment per install. This is what makes it possible to actually sell
ROSE to someone without walking them through their own Cloudflare account,
`wrangler login`, and `scripts/setup.sh`.

## The model

Every row that used to belong to "the household" (there was only one)
now belongs to *a* household: `conversations`, `messages`, `memories`, and
`people` all carry a `household_id` (migration
[`0003_households.sql`](../cloudflare/migrations/0003_households.sql)).
A new `households` table holds one row per customer:

```sql
CREATE TABLE households (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  api_key             TEXT UNIQUE,   -- the bearer token this household authenticates with
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  admin_pin_hash      TEXT,          -- see docs/cloudflare.md's "Admin PIN"
  admin_pin_salt      TEXT,
  integrator_id       TEXT,          -- see docs/integrators.md; NULL = not integrator-managed
  ha_url              TEXT,          -- this household's own Home Assistant instance
  ha_token_encrypted  TEXT           -- AES-256-GCM ciphertext, see crypto.ts
);
```

`ha_url`/`ha_token_encrypted` matter more than they might look: earlier,
`HA_URL`/`HA_TOKEN` were global Worker secrets — one Home Assistant instance
for the whole backend, which only made sense with a single household. Every
household now configures its own (see
[`integrators.md`](integrators.md#managing-a-households-home-assistant-connection)),
so two customers on the same backend each connect to their own home. The
old global secrets still work, but only as a fallback for the bootstrap
`default` household (`households.ts`'s `getHouseholdHaConfig`) — every
household added since keeps its connection in these two columns instead.

Every `/chat` request authenticates as exactly one household
(`households.ts`), and every read/write in `chat.ts`, `memory.ts`,
`people.ts`, and `recall.ts` is scoped to that household's own rows —
one household never sees another's conversations, memories, or people,
regardless of what `conversation_id` a client happens to send.

## Authentication: two paths

1. **The legacy path.** A request whose bearer token matches the
   `ROSE_API_KEY` Worker secret resolves to the **`default`** household —
   the one migration `0003` backfilled all pre-existing data into. This is
   why a deployment that predates multi-tenancy (this one, until now)
   keeps working with its existing key, unchanged — nothing to redo on
   your end.
2. **The households-table path.** Any other token is looked up in the
   `households` table by its `api_key` column. This is how every household
   added *after* multi-tenancy authenticates.

See `resolveHousehold()` in
[`cloudflare/src/households.ts`](../cloudflare/src/households.ts).

## Adding a new household

Two ways now:

1. **Through an integrator account** (the normal path going forward) — see
   [`integrators.md`](integrators.md). An integrator (installer/dealer) signs
   up or logs into the dashboard at `GET /dashboard` — a browser page, no
   terminal needed — creates a household under their account, and gets back
   its `api_key` — no D1 access needed, no talking to you.
2. **By hand**, still useful for the bootstrap household or one-off cases
   outside the integrator model:

   ```bash
   cd cloudflare
   NEW_ID="$(node -e "console.log(require('crypto').randomUUID())")"
   NEW_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
   npx wrangler d1 execute rose-db --remote --command \
     "INSERT INTO households (id, name, api_key) VALUES ('$NEW_ID', 'Customer name', '$NEW_KEY')"
   echo "Give this customer: $NEW_KEY"
   ```

Either way, hand that key (and this Worker's URL — the same one for every
household) to the customer. Whether they use the built-in chat page
(`GET /`) or the Home Assistant integration, all they need is that key —
same shape as `ROSE_API_KEY` from their point of view, just theirs and
theirs alone.

## What this deliberately doesn't do (yet)

- **No self-serve signup for homeowners.** An integrator can create a
  household through the dashboard API now (see above), but there's still no
  page where a homeowner signs *the household itself* up directly — only
  billing (below) is self-serve, on top of a household an integrator
  already created.
- **Billing exists, but is homeowner-direct, not through the
  integrator** — see [`billing.md`](billing.md). A homeowner claims their
  own household at `GET /portal` using its existing `api_key` and manages
  their own Stripe subscription; the integrator that set the household up
  technically has no role in that billing relationship.
- **No dashboard rename/delete/api_key-rotation** for a household yet — see
  [`integrators.md`](integrators.md) for what `GET /dashboard` covers today
  versus what's still ahead.
- **Vectorize isn't scoped by household at the database level.** Semantic
  recall (`recall.ts`) over-fetches a wide candidate pool from Vectorize
  (`max(topK * 10, 50)` results) and filters down to the requesting
  household in D1 afterward, rather than using a Vectorize metadata filter.
  This was a deliberate simplification: a real metadata filter needs a
  metadata index (`wrangler vectorize create-metadata-index`) *and*
  re-tagging every already-stored vector with a `household_id` (Vectorize
  has no bulk "add this metadata field retroactively" operation — it means
  re-embedding and re-upserting each one), which risked breaking
  recall for this deployment's own existing memories mid-migration. The
  over-fetch approach needed no changes to anything already stored.

  This is a **scale limit, not a security gap** — a household's memory
  *content* is never returned to a different household regardless of pool
  size; a too-small pool only risks this household's own relevant memory
  getting crowded out of the candidate window by other households'
  closer semantic matches, not exposing anyone else's. Fine for a handful
  of households; worth revisiting (real Vectorize-side filtering, with a
  proper backfill) once that stops being true.

None of this blocks having real, isolated households today — it just
means "sign up a customer" is a command you run, not a page they visit.
