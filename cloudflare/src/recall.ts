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
 *
 * `personId` filters out memories that belong to a *different* specific
 * person — household-wide memories (no person_id) always pass through.
 * Pass null when no speaker is currently identified, which surfaces
 * household-wide memories only.
 */
export async function recall(
  env: Env,
  query: string,
  personId: string | null,
  topK = 5
): Promise<RecalledMemory[]> {
  const vector = await embed(env, query);
  const matches = await env.MEMORY_INDEX.query(vector, { topK, returnMetadata: false });

  if (matches.matches.length === 0) {
    return [];
  }

  const ids = matches.matches.map((m) => m.id);
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(", ");
  const { results } = await env.DB.prepare(
    `SELECT id, content, person_id FROM memories WHERE id IN (${placeholders})`
  )
    .bind(...ids)
    .all<{ id: string; content: string; person_id: string | null }>();

  const rowById = new Map(results.map((r) => [r.id, r]));

  return matches.matches
    .filter((m) => {
      const row = rowById.get(m.id);
      return row !== undefined && (row.person_id === null || row.person_id === personId);
    })
    .map((m) => ({ id: m.id, content: rowById.get(m.id)!.content, score: m.score }));
}
