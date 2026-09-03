import type { Env } from "./index";

export interface Memory {
  id: string;
  content: string;
  source?: string;
  createdAt: string;
}

export async function embed(env: Env, text: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: env.OPENAI_EMBEDDING_MODEL, input: text }),
  });

  if (!res.ok) {
    throw new Error(`embeddings request failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { data: { embedding: number[] }[] };
  return data.data[0].embedding;
}

/**
 * Ensure a conversation row exists, then append a message to it. Both are
 * tagged with `householdId` — see docs/households.md — so a conversation_id
 * collision across two households (practically impossible; ids are random
 * UUIDs) still can't leak one household's messages into another's reads,
 * since every read below filters by household_id too.
 */
export async function recordMessage(
  env: Env,
  conversationId: string,
  householdId: string,
  role: "system" | "user" | "assistant",
  content: string
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO conversations (id, household_id) VALUES (?1, ?2)
       ON CONFLICT(id) DO UPDATE SET updated_at = datetime('now')`
    ).bind(conversationId, householdId),
    env.DB.prepare(
      `INSERT INTO messages (conversation_id, household_id, role, content) VALUES (?1, ?2, ?3, ?4)`
    ).bind(conversationId, householdId, role, content),
  ]);
}

/**
 * Return the most recent messages for a conversation, oldest first, for use
 * as short-term chat context.
 */
export async function getRecentMessages(
  env: Env,
  conversationId: string,
  householdId: string,
  limit = 20
): Promise<{ role: "system" | "user" | "assistant"; content: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT role, content FROM messages
     WHERE conversation_id = ?1 AND household_id = ?2
     ORDER BY created_at DESC, id DESC
     LIMIT ?3`
  )
    .bind(conversationId, householdId, limit)
    .all<{ role: "system" | "user" | "assistant"; content: string }>();

  return results.reverse();
}

/**
 * Persist a durable memory: store the text in D1 and its embedding in
 * Vectorize, linked by id. `personId` attributes it to a specific household
 * member (see people.ts); omitted or null means a fact for everyone in that
 * household, visible regardless of who's asking (but never to a *different*
 * household — see recall.ts).
 *
 * Takes an already-computed `vector` rather than embedding `content` itself
 * — callers need that same vector beforehand anyway, to check
 * `findSimilarMemory` (dedupe.ts) before deciding to store at all, and
 * embedding is a real OpenAI call not worth paying for twice.
 */
export async function storeMemory(
  env: Env,
  content: string,
  householdId: string,
  vector: number[],
  source?: string,
  personId?: string | null
): Promise<Memory> {
  const id = crypto.randomUUID();

  await Promise.all([
    env.DB.prepare(
      `INSERT INTO memories (id, content, source, person_id, household_id) VALUES (?1, ?2, ?3, ?4, ?5)`
    )
      .bind(id, content, source ?? null, personId ?? null, householdId)
      .run(),
    env.MEMORY_INDEX.insert([{ id, values: vector, metadata: { source: source ?? "" } }]),
  ]);

  return { id, content, source, createdAt: new Date().toISOString() };
}

/** The person a conversation is currently attributed to, if any. */
export async function getConversationPersonId(
  env: Env,
  conversationId: string,
  householdId: string
): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT person_id FROM conversations WHERE id = ?1 AND household_id = ?2`)
    .bind(conversationId, householdId)
    .first<{ person_id: string | null }>();
  return row?.person_id ?? null;
}

/** Attribute a conversation to a person from here on, creating the
 * conversation row if this is somehow called before its first message. */
export async function setConversationPerson(
  env: Env,
  conversationId: string,
  householdId: string,
  personId: string
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO conversations (id, household_id, person_id) VALUES (?1, ?2, ?3)
     ON CONFLICT(id) DO UPDATE SET person_id = ?3, updated_at = datetime('now')`
  )
    .bind(conversationId, householdId, personId)
    .run();
}
