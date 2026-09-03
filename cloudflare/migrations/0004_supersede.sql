-- Memory supersession: when a new memory updates or contradicts an
-- existing one (a changed job, a changed address, a stated preference
-- that's since changed), the old memory is marked superseded rather than
-- deleted — it stays in D1 permanently (so "I used to work at Acme" stays
-- knowable), it just stops being treated as *current*: recall.ts and
-- dedupe.ts both exclude superseded memories from their normal matching.
-- See supersede.ts for how a memory gets marked this way.
--
-- No DEFAULT on this column, so it doesn't hit the same "REFERENCES +
-- non-NULL DEFAULT" restriction 0003_households.sql did — this follows
-- the same shape as 0002_people.sql's plain nullable REFERENCES column,
-- already proven to work.
ALTER TABLE memories ADD COLUMN superseded_by TEXT REFERENCES memories(id);

CREATE INDEX IF NOT EXISTS idx_memories_superseded_by ON memories (superseded_by);
