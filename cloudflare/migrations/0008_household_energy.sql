-- Makes heat pump optimization actually multi-tenant. Before this, energy.ts
-- read a single global heat pump config (ROSE_HEATPUMP_ENTITY_ID etc.) and
-- the single global HA_URL/HA_TOKEN Worker secrets — meaning it could only
-- ever act on one household's home (whichever one happened to be using the
-- legacy global HA connection), no matter how many other households existed.
-- That stopped being acceptable the moment heating optimization became a
-- paid per-household add-on (docs/billing.md) — this gives every household
-- its own heat pump config, reusing its own HA connection
-- (households.ts's getHouseholdHaConfig, already multi-tenant).
--
-- Only what's genuinely home-specific moves here. MET_OFFICE_API_KEY stays
-- a global Worker secret (it's Brandon's own developer account, not
-- something each homeowner has); OCTOPUS_PRODUCT_CODE stays a global,
-- optional override (Octopus's Agile tariff code is the same nationally —
-- only the region letter varies per home, which does move here).
--
-- Solar (SolarEdge) and EV charging remain single-tenant/global for now,
-- deliberately out of scope for this migration — they're not sold as a
-- billed add-on yet (see docs/energy.md), so making them multi-tenant too
-- can wait until that's actually on offer.
ALTER TABLE households ADD COLUMN heatpump_entity_id TEXT;
ALTER TABLE households ADD COLUMN room_temp_entity_id TEXT;
ALTER TABLE households ADD COLUMN heating_min_temp_c REAL;
ALTER TABLE households ADD COLUMN heating_max_temp_c REAL;
ALTER TABLE households ADD COLUMN octopus_region TEXT;        -- single letter, A-P
ALTER TABLE households ADD COLUMN met_office_latitude TEXT;
ALTER TABLE households ADD COLUMN met_office_longitude TEXT;

-- Whether this household's Stripe subscription currently includes the
-- heating optimization add-on price (docs/billing.md) — kept in sync via
-- the same POST /billing/webhook that already maintains subscription_status
-- (migration 0007), by inspecting the subscription's line items. A
-- household needs BOTH this true AND the technical config above set before
-- energy.ts will actually do anything for it — see index.ts. Default 0
-- (false): every household today has neither.
ALTER TABLE households ADD COLUMN heating_addon_active INTEGER NOT NULL DEFAULT 0;

-- Both energy tables were originally single-tenant (no notion of "whose"
-- plan or event this was, because there was only ever one household it
-- could apply to). NULL household_id on any pre-existing row just means
-- "from before multi-tenancy" — harmless, and there's no real production
-- data to backfill given this launched only just before this migration.
ALTER TABLE energy_plans ADD COLUMN household_id TEXT;
CREATE INDEX IF NOT EXISTS idx_energy_plans_household_id ON energy_plans (household_id);
ALTER TABLE energy_events ADD COLUMN household_id TEXT;
CREATE INDEX IF NOT EXISTS idx_energy_events_household_id ON energy_events (household_id);
