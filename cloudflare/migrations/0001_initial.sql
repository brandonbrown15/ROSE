-- ROSE Core — initial schema
--
-- conversations: one row per HA conversation session
-- messages:      full transcript, used to reconstruct short-term context
-- memories:      durable facts distilled from conversations; the
--                corresponding embedding lives in Vectorize, keyed by
--                memories.vector_id

CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,        -- HA conversation_id
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
  ON messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS memories (
  id          TEXT PRIMARY KEY,        -- uuid, also used as the Vectorize vector id
  content     TEXT NOT NULL,           -- the distilled fact/memory text
  source      TEXT,                    -- e.g. conversation_id this was distilled from
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
