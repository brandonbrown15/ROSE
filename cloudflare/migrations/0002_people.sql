-- Phase 1 personalization: household members ROSE can attribute memories to.
--
-- Identity here is entirely self-reported — someone telling ROSE who they
-- are ("this is Sarah") — there is no voice biometrics. See docs/memory.md
-- for what a future phase would need to add real speaker identification
-- from audio instead.

CREATE TABLE IF NOT EXISTS people (
  id          TEXT PRIMARY KEY,        -- slug of the name, e.g. "sarah"
  name        TEXT NOT NULL,           -- display name, e.g. "Sarah"
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which person a conversation is currently attributed to, once someone has
-- identified themselves in it. NULL until then.
ALTER TABLE conversations ADD COLUMN person_id TEXT REFERENCES people(id);

-- NULL = household-wide fact (applies regardless of who's asking).
-- Set = a fact specifically about that person.
ALTER TABLE memories ADD COLUMN person_id TEXT REFERENCES people(id);

CREATE INDEX IF NOT EXISTS idx_memories_person_id ON memories (person_id);
