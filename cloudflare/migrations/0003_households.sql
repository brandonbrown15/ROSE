-- Multi-tenancy: one row per customer/household, so ROSE can run as a
-- single shared backend serving many households instead of a separate
-- Cloudflare deployment (own account, own D1, own Vectorize index) per
-- customer.
--
-- Vectorize itself is deliberately NOT scoped by household here — no
-- metadata index, no re-tagging of already-stored vectors. recall.ts
-- instead over-fetches candidates from Vectorize and filters to the
-- requesting household in D1 afterward. See docs/households.md for why,
-- and the upgrade path once that stops being good enough.

CREATE TABLE IF NOT EXISTS households (
  id          TEXT PRIMARY KEY,        -- uuid ('default' for the bootstrap row below)
  name        TEXT NOT NULL,
  -- The bearer token this household authenticates /chat with. NULL for the
  -- 'default' household below, which instead authenticates via the
  -- existing ROSE_API_KEY Worker secret (see households.ts) — so a
  -- deployment that predates multi-tenancy keeps working with its
  -- existing key, unchanged.
  api_key     TEXT UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bootstrap household: this deployment's own pre-existing (single-tenant)
-- data backfills to this one via the DEFAULT on each ALTER TABLE below.
-- ON CONFLICT DO NOTHING: defensive idempotency in case this statement
-- alone ever succeeds in a run that fails on a later statement — D1 runs
-- each migration file as one transaction so a later failure rolls this
-- back too, but there's no cost to being safe either way.
INSERT INTO households (id, name, api_key) VALUES ('default', 'Default household', NULL)
  ON CONFLICT(id) DO NOTHING;

-- No REFERENCES clause here on purpose: SQLite (and D1) rejects
-- `ALTER TABLE ADD COLUMN` when a REFERENCES clause is combined with a
-- non-NULL DEFAULT ("Cannot add a REFERENCES column with non-NULL
-- default value") — confirmed directly against a live D1 database, not
-- just docs. household_id is still a real foreign key conceptually
-- (see households.id above), just not one SQLite will let this
-- particular ALTER TABLE express. Unlike what an earlier version of
-- this comment assumed, D1 *does* enforce foreign keys at runtime by
-- default (also confirmed live, the hard way — see defer_foreign_keys
-- below) — this ALTER TABLE restriction just isn't related to that.
ALTER TABLE conversations ADD COLUMN household_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE messages      ADD COLUMN household_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE memories      ADD COLUMN household_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE people        ADD COLUMN household_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_conversations_household_id ON conversations (household_id);
CREATE INDEX IF NOT EXISTS idx_messages_household_conversation ON messages (household_id, conversation_id);
CREATE INDEX IF NOT EXISTS idx_memories_household_id ON memories (household_id);
CREATE INDEX IF NOT EXISTS idx_people_household_id ON people (household_id);

-- people.id used to be just a slug of the name (e.g. "sarah"), globally
-- unique. Two different households both having a "Sarah" would now
-- collide, so findOrCreatePerson namespaces new ids as
-- "<household_id>:<slug>" going forward — rewrite existing ids (and the
-- conversations.person_id / memories.person_id columns that reference
-- them) to match, so nothing already stored breaks or duplicates.
--
-- D1 enforces foreign keys at runtime (confirmed live — see the ALTER
-- TABLE comment above), so renaming people.id while it's referenced by
-- conversations.person_id/memories.person_id needs those three updates
-- treated as one atomic change, not three independent ones: whichever
-- order they run in, there's a moment where a person_id column points
-- at an id that doesn't exist yet (the old id if people.id already
-- changed, or the new prefixed one if it hasn't). defer_foreign_keys
-- delays FK *checking* until this transaction commits — SQLite/D1 still
-- runs the statements in order, it just doesn't validate the
-- constraint until everything below has happened, by which point
-- they agree again.
PRAGMA defer_foreign_keys = ON;
UPDATE memories      SET person_id = 'default:' || person_id WHERE person_id IS NOT NULL;
UPDATE conversations SET person_id = 'default:' || person_id WHERE person_id IS NOT NULL;
UPDATE people         SET id        = 'default:' || id;
