import type { Env } from "./index";
import { embed } from "./memory";

export interface RecalledMemory {
  id: string;
  content: string;
  score: number;
  /** false if this memory has been superseded (supersede.ts) — still
   * genuinely true of the past, just not the current state. chat.ts labels
   * these when building RELEVANT MEMORIES so the model never mistakes a
   * retired fact for a current one. */
  current: boolean;
}

/**
 * Semantic recall: embed the query, search Vectorize for the closest stored
 * memories, and return the matching text pulled back from D1.
 *
 * `householdId` scopes results to one household's own memories — see
 * docs/households.md. Vectorize itself isn't scoped by household (no
 * metadata index, so no re-tagging needed for memories stored before
 * multi-tenancy); instead this over-fetches a wider candidate pool than
 * `topK` and filters down to `householdId`'s own rows in D1 afterward,
 * then takes the first `topK` of *those* (Vectorize already returns
 * matches best-score-first, so filtering preserves that order). This is
 * an app-level, not Vectorize-level, isolation boundary: a household's
 * memory *content* is never returned to a different household regardless
 * of candidate pool size — a too-small pool only risks missing a relevant
 * memory, never leaking one. Worth revisiting (a real Vectorize metadata
 * filter) once enough households exist that a wide pool isn't reliably
 * enough to surface one specific household's relevant memories.
 *
 * `personId` filters out memories that belong to a *different* specific
 * person — household-wide memories (no person_id) always pass through.
 * Pass null when no speaker is currently identified, which surfaces
 * household-wide memories only.
 *
 * Superseded memories (see supersede.ts) are still eligible to come back —
 * a retired fact ("used to work at Acme") is genuinely relevant to plenty
 * of questions ("help me apply for this job" should draw on past *and*
 * current experience), so excluding it outright would make recall worse,
 * not more correct. What changes is the `current` flag on each result:
 * chat.ts labels non-current ones in RELEVANT MEMORIES, so the model
 * always knows which is the live fact and which is history, and ranking
 * is unaffected either way — a superseded memory only shows up when it's
 * actually one of the closest semantic matches to the query, same as any
 * other memory.
 */
export async function recall(
  env: Env,
  query: string,
  personId: string | null,
  householdId: string,
  topK = 5
): Promise<RecalledMemory[]> {
  const vector = await embed(env, query);
  const candidatePool = Math.max(topK * 10, 50);
  // "none" — a boolean here type-checks (the .d.ts still permits it for
  // backwards compatibility) but the live API rejects `false` at runtime
  // with a JSON-parsing error; the string enum is what it actually wants.
  const matches = await env.MEMORY_INDEX.query(vector, { topK: candidatePool, returnMetadata: "none" });

  if (matches.matches.length === 0) {
    return [];
  }

  const ids = matches.matches.map((m) => m.id);
  const placeholders = ids.map((_, i) => `?${i + 2}`).join(", ");
  const { results } = await env.DB.prepare(
    `SELECT id, content, person_id, superseded_by FROM memories
     WHERE household_id = ?1 AND id IN (${placeholders})`
  )
    .bind(householdId, ...ids)
    .all<{ id: string; content: string; person_id: string | null; superseded_by: string | null }>();

  const rowById = new Map(results.map((r) => [r.id, r]));

  return matches.matches
    .filter((m) => {
      const row = rowById.get(m.id);
      return row !== undefined && (row.person_id === null || row.person_id === personId);
    })
    .slice(0, topK)
    .map((m) => {
      const row = rowById.get(m.id)!;
      return { id: m.id, content: row.content, score: m.score, current: row.superseded_by === null };
    });
}
