-- Address-based location (instead of raw lat/long) and automatic
-- heating/cooling switching by outdoor temperature.
--
-- Postcode: households already store met_office_latitude/longitude for the
-- Met Office forecast call — those stay the source of truth at runtime
-- (nothing in energy.ts changes), but making an installer type decimal
-- coordinates by hand was exactly the kind of fiddly setup step this
-- product shouldn't have. From now on the dashboard collects a UK postcode
-- and the Worker resolves it to lat/long once, at save time (see
-- cloudflare/src/postcodes.ts), storing both — postcode purely for
-- display/audit, lat/long for every actual Met Office call. Nullable: a
-- household configured before this migration already has lat/long and
-- keeps working identically with no postcode on file until its integrator
-- re-saves the form.
ALTER TABLE households ADD COLUMN postcode TEXT;

-- Automatic heat/cool switching: hvac_mode gains a third value, 'auto',
-- handled entirely in application code (households.ts/energy.ts) — no CHECK
-- constraint, same as how hvac_mode/tariff_type already work. In 'auto',
-- energy.ts decides heat vs. cool itself each cycle from the live/forecast
-- outdoor temperature, with hysteresis between two thresholds so a
-- borderline day doesn't flip a household's heat pump/AC direction every
-- 30-minute cycle (see energy.ts's resolveEffectiveHvacMode).
--
-- hvac_auto_state is the sticky memory of which side of that hysteresis
-- band a household is currently on — defaults to 'heat' so a household
-- newly switched to 'auto' starts out heating (the common case for most of
-- a UK year) until a cycle actually sees a hot outdoor reading move it.
-- hvac_auto_heat_below_c / hvac_auto_cool_above_c are the two thresholds,
-- defaulting to 18°C / 24°C — sensible-enough UK defaults that 'auto' works
-- out of the box, overridable per household from the dashboard.
ALTER TABLE households ADD COLUMN hvac_auto_state TEXT NOT NULL DEFAULT 'heat';
ALTER TABLE households ADD COLUMN hvac_auto_heat_below_c REAL NOT NULL DEFAULT 18;
ALTER TABLE households ADD COLUMN hvac_auto_cool_above_c REAL NOT NULL DEFAULT 24;
