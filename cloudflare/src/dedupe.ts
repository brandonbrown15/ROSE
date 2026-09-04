import type { Env } from "./index";

// Cosine similarity above which a new memory is considered a restatement of
// an existing one rather than a genuinely new fact. Tuned to catch near-
// identical rephrasings ("Brandon likes his coffee black" said three
// different ways) without merging facts that are merely topically related
// ("Brandon likes coffee" vs "Brandon likes tea") — those should stay
// separate. Adjust if it's too eager (distinct facts vanishing) or not
// eager enough (obvious restatements still slipping through).
const SIMILARITY_THRESHOLD = 0.93;

/**
 * Look for an existing memory in the same scope (household, and the same
 * person — or the same household-wide "everyone" scope) that's essentially
 * a restatement of `vector`. Returns its id if found, so the caller can
 * skip storing a redundant duplicate; null if this looks like a genuinely
 * new fact.
 *
 * Deliberately scoped tighter than recall.ts's household-wide "everyone or
 * this person" filter: two people in the same household each having their
 * own "takes coffee black" memory aren't duplicates of each other, so this
 * only matches an *exact* person_id match (both null, or the same person).
 * Excludes already-superseded memories (supersede.ts) too — nothing should
 * be treated as a restatement of a fact that's already been retired.
 */
export async function findSimilarMemory(
  env: Env,
  vector: number[],
  householdId: string,
  personId: string | null
): Promise<string | null> {
  // A small pool is enough — unlike recall.ts we only care whether the
  // single closest same-scope match is a near-duplicate, not about
  // gathering a broad candidate set.
  const matches = await env.MEMORY_INDEX.query(vector, { topK: 10, returnMetadata: "none" });
  if (matches.matches.length === 0) {
    return null;
  }

  const ids = matches.matches.map((m) => m.id);
  const placeholders = ids.map((_, i) => `?${i + 2}`).join(", ");
  const { results } = await env.DB.prepare(
    `SELECT id, person_id FROM memories
     WHERE household_id = ?1 AND superseded_by IS NULL AND id IN (${placeholders})`
  )
    .bind(householdId, ...ids)
    .all<{ id: string; person_id: string | null }>();

  const rowById = new Map(results.map((r) => [r.id, r]));

  // matches.matches is already sorted best-score-first, so the first one
  // in this scope is the closest.
  const closest = matches.matches.find((m) => rowById.get(m.id)?.person_id === personId);

  return closest && closest.score >= SIMILARITY_THRESHOLD ? closest.id : null;
}
