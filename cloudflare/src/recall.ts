import type { Env } from "./index";
import { embed } from "./memory";

export interface RecalledMemory {
  id: string;
  content: string;
  score: number;
}

/**
 * Semantic recall: embed the query, search Vectorize for the closest stored
 * memories, and return the matching text pulled back from D1.
 */
export async function recall(env: Env, query: string, topK = 5): Promise<RecalledMemory[]> {
  const vector = await embed(env, query);
  const matches = await env.MEMORY_INDEX.query(vector, { topK, returnMetadata: false });

  if (matches.matches.length === 0) {
    return [];
  }

  const ids = matches.matches.map((m) => m.id);
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(", ");
  const { results } = await env.DB.prepare(
    `SELECT id, content FROM memories WHERE id IN (${placeholders})`
  )
    .bind(...ids)
    .all<{ id: string; content: string }>();

  const contentById = new Map(results.map((r) => [r.id, r.content]));

  return matches.matches
    .filter((m) => contentById.has(m.id))
    .map((m) => ({ id: m.id, content: contentById.get(m.id)!, score: m.score }));
}
