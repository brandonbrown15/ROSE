-- Solar/EV events — a lightweight log distinct from energy_plans (which is
-- the 24h price/weather schedule). Currently just EV charge start/stop
-- decisions, driven by live SolarEdge surplus readings. See docs/energy.md.

CREATE TABLE IF NOT EXISTS energy_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,   -- e.g. 'ev_charge_start', 'ev_charge_stop'
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_energy_events_created_at ON energy_events (created_at);
