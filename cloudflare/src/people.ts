import type { Env } from "./index";

export interface Person {
  id: string;
  name: string;
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** All of one household's members ROSE currently knows about, for matching
 * against in speaker identification. */
export async function listPeople(env: Env, householdId: string): Promise<Person[]> {
  const { results } = await env.DB.prepare(`SELECT id, name FROM people WHERE household_id = ?1 ORDER BY name`)
    .bind(householdId)
    .all<Person>();
  return results;
}

/**
 * Look up a person by display name within one household, creating them if
 * this is the first time they've been mentioned. Names are matched by their
 * slug scoped to the household ("<household_id>:<slug>"), so "Sarah" and
 * "sarah" resolve to the same person within a household, two different
 * households can each have their own "Sarah" without colliding, and two
 * different people in the *same* household who happen to slugify to the
 * same id will still collide — an accepted limitation for now.
 */
export async function findOrCreatePerson(env: Env, householdId: string, name: string): Promise<Person> {
  const slug = slugify(name);
  if (!slug) {
    throw new Error("person name must contain at least one letter or digit");
  }
  const id = `${householdId}:${slug}`;

  await env.DB.prepare(`INSERT INTO people (id, name, household_id) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO NOTHING`)
    .bind(id, name.trim(), householdId)
    .run();

  const row = await env.DB.prepare(`SELECT id, name FROM people WHERE id = ?1`).bind(id).first<Person>();

  // The row above was either just inserted or already existed, so this can
  // never actually miss — the ! just satisfies the type checker.
  return row!;
}
