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

/** All household members ROSE currently knows about, for matching against
 * in speaker identification. */
export async function listPeople(env: Env): Promise<Person[]> {
  const { results } = await env.DB.prepare(`SELECT id, name FROM people ORDER BY name`).all<Person>();
  return results;
}

/**
 * Look up a person by display name, creating them if this is the first time
 * they've been mentioned. Names are matched by their slug, so "Sarah" and
 * "sarah" resolve to the same person; two different people who happen to
 * slugify to the same id will collide — an accepted limitation for now.
 */
export async function findOrCreatePerson(env: Env, name: string): Promise<Person> {
  const id = slugify(name);
  if (!id) {
    throw new Error("person name must contain at least one letter or digit");
  }

  await env.DB.prepare(`INSERT INTO people (id, name) VALUES (?1, ?2) ON CONFLICT(id) DO NOTHING`)
    .bind(id, name.trim())
    .run();

  const row = await env.DB.prepare(`SELECT id, name FROM people WHERE id = ?1`).bind(id).first<Person>();

  // The row above was either just inserted or already existed, so this can
  // never actually miss — the ! just satisfies the type checker.
  return row!;
}
