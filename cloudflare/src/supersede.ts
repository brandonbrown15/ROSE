import type { Env } from "./index";

export interface SupersedeCandidate {
  id: string;
  content: string;
}

// Cosine similarity floor for even considering asking the model whether a
// new memory updates an existing one. Deliberately lower than dedupe.ts's
// near-duplicate threshold — "Brandon works at Acme Corp" and "Brandon
// works at Globex Corp" are meaningfully less similar as raw text than two
// phrasings of the identical fact, but still close enough to be worth
// asking about. Below this, two memories are treated as unrelated.
const CANDIDATE_THRESHOLD = 0.75;
const MAX_CANDIDATES = 5;

function buildSupersedePrompt(candidates: SupersedeCandidate[]): string {
  const list = candidates.map((c, i) => `${i + 1}. [id: ${c.id}] ${c.content}`).join("\n");
  return `You review a new fact about to be saved to memory, alongside a short list \
of existing memories that are semantically close to it. Decide whether the new \
fact is an UPDATE to exactly one of them — the same real-world thing changing \
value (a job, an address, a stated preference that's since changed) — not merely \
related to it. Two facts that can both still be true at the same time (e.g. \
"likes coffee" and "likes tea") are NOT an update, even if topically similar.

Existing memories:
${list}

Respond with ONLY a JSON object: {"supersedes_id": string | null} — the id of \
the one existing memory this new fact replaces, or null if none of them is \
actually being updated (including whenever you're not sure — don't guess).`;
}

/**
 * Find existing memories in the same scope close enough to the new one to
 * be worth checking for a possible update. Excludes already-superseded
 * memories — nothing should be "updating" a fact that's already retired —
 * and relies on the caller (chat.ts) to have already ruled out a near-exact
 * duplicate via dedupe.ts before calling this.
 */
export async function findSupersedeCandidates(
  env: Env,
  vector: number[],
  householdId: string,
  personId: string | null
): Promise<SupersedeCandidate[]> {
  const matches = await env.MEMORY_INDEX.query(vector, { topK: 20, returnMetadata: "none" });
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
    .filter((m) => m.score >= CANDIDATE_THRESHOLD)
    .filter((m) => rowById.get(m.id)?.person_id === personId)
    .slice(0, MAX_CANDIDATES)
    .map((m) => ({ id: m.id, content: rowById.get(m.id)!.content }));
}

/**
 * Ask the model whether the new memory actually updates one of the
 * candidates. Never throws — a failure here just means nothing gets marked
 * superseded, the same way a distillation failure just means nothing gets
 * remembered.
 */
export async function detectSupersession(
  env: Env,
  newContent: string,
  candidates: SupersedeCandidate[]
): Promise<string | null> {
  if (candidates.length === 0) {
    return null;
  }

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.OPENAI_CHAT_MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildSupersedePrompt(candidates) },
          { role: "user", content: newContent },
        ],
      }),
    });

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    const parsed = JSON.parse(data.choices[0].message.content) as { supersedes_id?: string | null };

    if (typeof parsed.supersedes_id === "string" && candidates.some((c) => c.id === parsed.supersedes_id)) {
      return parsed.supersedes_id;
    }
  } catch {
    // Malformed JSON, network error, etc. — treat as "no supersession".
  }

  return null;
}
