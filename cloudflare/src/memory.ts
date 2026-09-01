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
 * Ensure a conversation row exists, then append a message to it.
 */
export async function recordMessage(
  env: Env,
  conversationId: string,
  role: "system" | "user" | "assistant",
  content: string
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO conversations (id) VALUES (?1)
       ON CONFLICT(id) DO UPDATE SET updated_at = datetime('now')`
    ).bind(conversationId),
    env.DB.prepare(
      `INSERT INTO messages (conversation_id, role, content) VALUES (?1, ?2, ?3)`
    ).bind(conversationId, role, content),
  ]);
}

/**
 * Return the most recent messages for a conversation, oldest first, for use
 * as short-term chat context.
 */
export async function getRecentMessages(
  env: Env,
  conversationId: string,
  limit = 20
): Promise<{ role: "system" | "user" | "assistant"; content: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT role, content FROM messages
     WHERE conversation_id = ?1
     ORDER BY created_at DESC, id DESC
     LIMIT ?2`
  )
    .bind(conversationId, limit)
    .all<{ role: "system" | "user" | "assistant"; content: string }>();

  return results.reverse();
}

/**
 * Persist a durable memory: store the text in D1 and its embedding in
 * Vectorize, linked by id.
 */
export async function storeMemory(env: Env, content: string, source?: string): Promise<Memory> {
  const id = crypto.randomUUID();
  const vector = await embed(env, content);

  await Promise.all([
    env.DB.prepare(`INSERT INTO memories (id, content, source) VALUES (?1, ?2, ?3)`)
      .bind(id, content, source ?? null)
      .run(),
    env.MEMORY_INDEX.insert([{ id, values: vector, metadata: { source: source ?? "" } }]),
  ]);

  return { id, content, source, createdAt: new Date().toISOString() };
}
