-- Integrator accounts: the dealer/installer layer above households. One
-- integrator logs into a dashboard (see docs/integrators.md) and manages
-- many client households underneath — this table is that login; households
-- gain integrator_id to record who set each one up.
--
-- No REFERENCES clause on integrator_id, matching migration 0003's
-- household_id columns — SQLite/D1 rejects combining REFERENCES with a
-- non-NULL DEFAULT on ADD COLUMN, and integrator_id has no default here
-- anyway (NULL = not integrator-managed, e.g. the bootstrap 'default'
-- household), so this is just staying consistent with the established
-- pattern rather than hitting that restriction fresh.
CREATE TABLE IF NOT EXISTS integrators (
  id            TEXT PRIMARY KEY,   -- uuid
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  password_hash TEXT NOT NULL,      -- PBKDF2-SHA256, see cloudflare/src/crypto.ts
  password_salt TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE households ADD COLUMN integrator_id TEXT;
CREATE INDEX IF NOT EXISTS idx_households_integrator_id ON households (integrator_id);

-- Per-household Home Assistant connection. Previously HA_URL/HA_TOKEN were
-- global Worker secrets — one Home Assistant instance for the entire
-- backend, fine for a single household but wrong once an integrator is
-- onboarding multiple clients, each with their own HA instance. ha_url is
-- plain (not a secret — same reasoning as the D1 database_id elsewhere in
-- this repo, a pointer not a credential); ha_token_encrypted is AES-256-GCM
-- ciphertext (see crypto.ts's encryptSecret/decryptSecret) — unlike the
-- admin PIN, ROSE genuinely needs this back in plaintext to call HA's API,
-- so it can't just be hashed the way the PIN is.
--
-- Both NULL means this household has no HA connection configured — chat.ts
-- falls back to the legacy global HA_URL/HA_TOKEN secrets, but only for the
-- 'default' household (see households.ts's getHouseholdHaConfig), so
-- existing single-tenant deployments keep working unchanged.
ALTER TABLE households ADD COLUMN ha_url TEXT;
ALTER TABLE households ADD COLUMN ha_token_encrypted TEXT;
