import type { Env } from "./index";
import {
  clearSignedCookie,
  createSignedCookie,
  extractCookie,
  hashSecret,
  verifySecret,
  verifySignedCookie,
} from "./crypto";

export interface Integrator {
  id: string;
  email: string;
  name: string | null;
}

// --- Signup / login ----------------------------------------------------------

/** Register a new integrator account. Throws if the email's already taken —
 * callers turn that into a 409, not a 500. */
export async function createIntegrator(
  env: Env,
  email: string,
  password: string,
  name?: string
): Promise<Integrator> {
  const existing = await env.DB.prepare(`SELECT id FROM integrators WHERE email = ?1`).bind(email).first();
  if (existing) {
    throw new Error("email already registered");
  }

  const id = crypto.randomUUID();
  const { hash, salt } = await hashSecret(password);

  await env.DB.prepare(
    `INSERT INTO integrators (id, email, name, password_hash, password_salt) VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(id, email, name ?? null, hash, salt)
    .run();

  return { id, email, name: name ?? null };
}

/** Check an email/password pair. Returns the integrator on success, null on
 * any failure (unknown email, wrong password) — deliberately the same
 * response either way, so a login attempt never reveals whether an email is
 * registered. */
export async function verifyIntegratorLogin(env: Env, email: string, password: string): Promise<Integrator | null> {
  const row = await env.DB.prepare(
    `SELECT id, email, name, password_hash, password_salt FROM integrators WHERE email = ?1`
  )
    .bind(email)
    .first<{ id: string; email: string; name: string | null; password_hash: string; password_salt: string }>();

  if (!row) {
    return null;
  }

  const valid = await verifySecret(password, row.password_salt, row.password_hash);
  return valid ? { id: row.id, email: row.email, name: row.name } : null;
}

// --- Sessions (signed cookie, stateless) --------------------------------------
//
// A thin wrapper over crypto.ts's generic signed-cookie helpers — see that
// module's comment for the mechanics and the tradeoff (no early revocation
// short of rotating SESSION_SECRET, which now logs out both integrators and
// customers.ts's homeowner sessions at once, since they share the secret).
// SESSION_COOKIE_NAME doubles as the signing domain, so an integrator
// session can never be replayed as a customer-portal one or vice versa.

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_COOKIE_NAME = "rose_session";

/** A `Set-Cookie` header value that logs an integrator in. */
export async function createSessionCookie(env: Env, integratorId: string): Promise<string> {
  return createSignedCookie(env.SESSION_SECRET, SESSION_COOKIE_NAME, SESSION_COOKIE_NAME, integratorId, SESSION_DURATION_MS);
}

/** A `Set-Cookie` header value that logs an integrator out. */
export function clearSessionCookie(): string {
  return clearSignedCookie(SESSION_COOKIE_NAME);
}

/** Pull the raw session cookie value out of a request's Cookie header, if
 * present — pass the result to verifySessionCookie. */
export function extractSessionCookie(request: Request): string | null {
  return extractCookie(request, SESSION_COOKIE_NAME);
}

/** Verify a session cookie value and return the integrator id it
 * authenticates, or null if missing, malformed, expired, or tampered with. */
export async function verifySessionCookie(env: Env, cookieValue: string | null): Promise<string | null> {
  return verifySignedCookie(env.SESSION_SECRET, SESSION_COOKIE_NAME, cookieValue);
}
