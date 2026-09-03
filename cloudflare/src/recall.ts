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
 * Superseded memories (see supersede.ts) are excluded — recall only ever
 * surfaces what's *current*. A superseded memory isn't deleted, it just
 * stops showing up here; ROSE won't see a stale "works at Acme" alongside
 * a newer "works at Globex," only the current one.
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
    `SELECT id, content, person_id FROM memories
     WHERE household_id = ?1 AND superseded_by IS NULL AND id IN (${placeholders})`
  )
    .bind(householdId, ...ids)
    .all<{ id: string; content: string; person_id: string | null }>();

  const rowById = new Map(results.map((r) => [r.id, r]));

  return matches.matches
    .filter((m) => {
      const row = rowById.get(m.id);
      return row !== undefined && (row.person_id === null || row.person_id === personId);
    })
    .slice(0, topK)
    .map((m) => ({ id: m.id, content: rowById.get(m.id)!.content, score: m.score }));
}
