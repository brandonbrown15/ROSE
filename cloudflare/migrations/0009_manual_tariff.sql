-- Multi-tariff support for heat pump optimization. Octopus Agile is the
-- only major UK supplier with a public, free, live half-hourly dynamic
-- pricing API — every other supplier's time-of-use tariff (Economy 7/10,
-- OVO Charge Anytime, EDF GoElectric, or a plain flat rate) has no
-- equivalent to pull live. So "works with any tariff" (matching Homely's
-- own claim) can't mean a live API for everyone — it means a manually
-- entered tariff schedule as the alternative to Octopus Agile, which the
-- optimizer schedules against exactly the same way, just without reacting
-- to live price changes there aren't any of. See docs/energy.md.
--
-- tariff_type is NOT NULL DEFAULT 'octopus_agile' so every household
-- configured before this migration keeps behaving exactly as it did —
-- their octopus_region is still required and still used, nothing changes
-- for them. A household only needs the manual_tariff_* columns once its
-- integrator actually sets tariff_type = 'manual'.
ALTER TABLE households ADD COLUMN tariff_type TEXT NOT NULL DEFAULT 'octopus_agile';

-- The household's day-rate, pence/kWh — the rate that applies whenever no
-- off-peak window (below) is in effect. For a flat-rate tariff, this is
-- the only number needed.
ALTER TABLE households ADD COLUMN manual_tariff_default_pence REAL;

-- Zero or more cheaper time-of-use windows, as a JSON array of
-- {"start": "HH:MM", "end": "HH:MM", "pence": number} objects (local time,
-- validated non-overlapping in code — see households.ts). Empty/NULL means
-- a flat rate all day. Stored as JSON text since D1/SQLite has no array
-- column type; small and read as a whole, never queried by index, so this
-- is the right tradeoff over a separate table.
ALTER TABLE households ADD COLUMN manual_tariff_off_peak_json TEXT;
