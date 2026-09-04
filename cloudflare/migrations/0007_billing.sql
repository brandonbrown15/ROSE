-- Homeowner-facing billing accounts + Stripe linkage. See docs/billing.md
-- and cloudflare/src/customers.ts / stripe.ts.
--
-- customer_email/password are a third, separate login on top of a
-- household — distinct from the household's own chat/HA bearer token
-- (households.ts's api_key) and from an integrator dashboard login
-- (integrators.ts). A homeowner "claims" their household by proving they
-- hold its api_key (see customers.ts's claimHousehold), then sets an
-- email+password so they don't need that key again just to check billing.
-- NULL customer_email means nobody's claimed this household yet — nothing
-- about chat, HA control, or the integrator dashboard changes because of
-- that; billing is opt-in on top of an otherwise fully working household,
-- same pattern as every other optional feature added so far (admin PIN's
-- default, energy optimization, web search).
--
-- Verified locally against a minimal repro schema (households.ts's actual
-- columns) before writing: multiple NULL customer_emails coexist fine
-- under the UNIQUE index (SQLite treats NULLs as distinct from each other),
-- a real duplicate is correctly rejected, and PRAGMA foreign_key_check
-- comes back clean. No REFERENCES + non-NULL DEFAULT combined on any ADD
-- COLUMN here (the restriction earlier migrations ran into) since none of
-- these columns has a default at all.
ALTER TABLE households ADD COLUMN customer_email TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_households_customer_email ON households (customer_email);
ALTER TABLE households ADD COLUMN customer_password_hash TEXT; -- PBKDF2-SHA256, see crypto.ts
ALTER TABLE households ADD COLUMN customer_password_salt TEXT;

-- Stripe linkage + a cached copy of subscription status, kept in sync via
-- Stripe webhook events (index.ts's POST /billing/webhook) rather than
-- queried live from Stripe on every request. subscription_status is one
-- of Stripe's own subscription status strings (e.g. 'active', 'trialing',
-- 'past_due', 'canceled', 'incomplete') or NULL.
--
-- NULL means no subscription has ever been created for this household —
-- households.ts's resolveHousehold (and everything downstream of it,
-- including chat.ts) treats that exactly like today: fully working, never
-- blocked. Every household that exists right now is NULL here after this
-- migration runs, so nothing currently deployed changes behavior. Only
-- 'past_due' and 'canceled' — a household that *did* engage billing and
-- then lapsed — cause index.ts to refuse new /chat messages until it's
-- resolved.
ALTER TABLE households ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE households ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE households ADD COLUMN subscription_status TEXT;
