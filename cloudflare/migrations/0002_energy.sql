-- Energy optimization — stores each computed heating plan slot so ROSE can
-- explain past/upcoming decisions and so /energy/status has something to
-- read without recomputing. See docs/energy.md.

CREATE TABLE IF NOT EXISTS energy_plans (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_start      TEXT NOT NULL,   -- ISO timestamp, UTC, inclusive
  slot_end        TEXT NOT NULL,   -- ISO timestamp, UTC, exclusive
  target_temp_c   REAL NOT NULL,
  pence_per_kwh   REAL NOT NULL,
  outside_temp_c  REAL,
  estimated_cop   REAL,
  reason          TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_energy_plans_slot_start ON energy_plans (slot_start);
