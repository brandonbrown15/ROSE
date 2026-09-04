-- Standalone Boreas device support (docs/boreas-device.md, Open question 1
-- — resolved: standalone). A Boreas unit is neither a household's own
-- client (the bearer token households.api_key already covers — chat, the
-- HA integration) nor an integrator logging into the dashboard: it's a
-- physical device sitting in a customer's consumer unit, behind their own
-- home network/NAT, that the Worker can never dial into directly. So the
-- control flow flips from the existing Home-Assistant model (Worker reaches
-- out to a household's own publicly-tunnelled HA instance) to the device
-- periodically polling the Worker instead — the standard shape for
-- anything living behind a home router (see boreas-device.md).
--
-- heatpump_control picks which of the two control paths a household's
-- config uses. NOT NULL DEFAULT 'home_assistant' so every household
-- configured before this exists keeps working exactly as it did — nothing
-- here changes behavior for the current Home-Assistant-only path.
ALTER TABLE households ADD COLUMN heatpump_control TEXT NOT NULL DEFAULT 'home_assistant';

-- One row per physical unit. device_key is its own bearer credential —
-- deliberately NOT the household's own api_key, so a device physically
-- installed in a consumer unit (higher physical-access risk than a phone
-- or a cloud HA tunnel) can be revoked/rotated without touching the
-- household's chat/HA credential. Stored in plaintext, matching
-- households.api_key's own documented simplification (see households.md)
-- rather than inventing a different security bar for this one credential.
--
-- UNIQUE(household_id): one device per household for v1, matching the
-- existing "single room, single heat pump" limitation (docs/energy.md) —
-- provisioning re-generates (rotates) the same row rather than creating a
-- second one. Revisit alongside multi-zone support.
--
-- last_room_temp_c/last_seen_at: what the device last reported, replacing
-- the room_temp_entity_id sensor read energy.ts would otherwise do via
-- Home Assistant. pending_target_temp_c/pending_hvac_mode: what the last
-- optimization cycle (energy.ts, unchanged cadence) computed for this
-- household — the device picks it up on its next check-in and applies it
-- itself (via whatever local interface it has to the heat pump — RS485/
-- Modbus, etc.), since the Worker has no way to push to it directly.
CREATE TABLE boreas_devices (
  id                     TEXT PRIMARY KEY,
  household_id           TEXT NOT NULL UNIQUE REFERENCES households(id),
  device_key             TEXT NOT NULL UNIQUE,
  name                   TEXT,
  last_room_temp_c       REAL,
  last_seen_at           TEXT,
  pending_target_temp_c  REAL,
  pending_hvac_mode      TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
