import type { Env } from "./index";

export interface Household {
  id: string;
  name: string;
}

/**
 * Resolve a bearer token to the household it authenticates as, or null if
 * it doesn't match anything. Two paths:
 *
 *  - The token equals `env.ROSE_API_KEY` — the legacy single-tenant secret.
 *    Resolves to the bootstrap 'default' household (see migration 0003)
 *    without touching D1, so a deployment that predates multi-tenancy
 *    keeps working with its existing key unchanged.
 *  - Otherwise, look it up in the `households` table — this is how every
 *    household added after multi-tenancy authenticates (see
 *    docs/households.md for how to add one).
 */
export async function resolveHousehold(env: Env, token: string): Promise<Household | null> {
  if (env.ROSE_API_KEY && token === env.ROSE_API_KEY) {
    return { id: "default", name: "Default household" };
  }

  const row = await env.DB.prepare(`SELECT id, name FROM households WHERE api_key = ?1`)
    .bind(token)
    .first<Household>();
  return row ?? null;
}
