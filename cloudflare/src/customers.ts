import type { Env } from "./index";
import {
  clearSignedCookie,
  createSignedCookie,
  extractCookie,
  hashSecret,
  verifySecret,
  verifySignedCookie,
} from "./crypto";
import { resolveHousehold } from "./households";

// Homeowner-facing billing accounts — a third, separate login system
// alongside a household's chat/HA bearer token (households.ts) and an
// integrator's dashboard login (integrators.ts). Deliberately billed
// directly rather than through the integrator: a homeowner claims their
// own household here and manages their own subscription, independent of
// whoever installed the system. See docs/billing.md.

export interface Customer {
  householdId: string;
  email: string;
}

/** Claim a household for self-service billing. Proves ownership via the
 * household's own api_key — the same credential its integrator (or
 * households.md's manual path) already handed the homeowner for chat/HA —
 * rather than inventing a separate invite system. Sets an email+password so
 * the homeowner can come back without that key. Throws (never a generic
 * 500 — see index.ts) on: an api_key that doesn't resolve, a household
 * that's already been claimed, or an email already in use by a different
 * household. */
export async function claimHousehold(env: Env, apiKey: string, email: string, password: string): Promise<Customer> {
  const household = await resolveHousehold(env, apiKey);
  if (!household) {
    throw new Error("invalid API key");
  }

  const existing = await env.DB.prepare(`SELECT customer_email FROM households WHERE id = ?1`)
    .bind(household.id)
    .first<{ customer_email: string | null }>();
  if (existing?.customer_email) {
    throw new Error("this household already has a billing account — log in instead");
  }

  const emailTaken = await env.DB.prepare(`SELECT id FROM households WHERE customer_email = ?1`)
    .bind(email)
    .first();
  if (emailTaken) {
    throw new Error("email already in use");
  }

  const { hash, salt } = await hashSecret(password);
  await env.DB.prepare(
    `UPDATE households SET customer_email = ?1, customer_password_hash = ?2, customer_password_salt = ?3 WHERE id = ?4`
  )
    .bind(email, hash, salt, household.id)
    .run();

  return { householdId: household.id, email };
}

/** Check an email/password pair. Returns the customer on success, null on
 * any failure — same "don't reveal whether the email is registered"
 * reasoning as verifyIntegratorLogin. */
export async function verifyCustomerLogin(env: Env, email: string, password: string): Promise<Customer | null> {
  const row = await env.DB.prepare(
    `SELECT id, customer_email, customer_password_hash, customer_password_salt FROM households WHERE customer_email = ?1`
  )
    .bind(email)
    .first<{
      id: string;
      customer_email: string;
      customer_password_hash: string;
      customer_password_salt: string;
    }>();

  if (!row) {
    return null;
  }

  const valid = await verifySecret(password, row.customer_password_salt, row.customer_password_hash);
  return valid ? { householdId: row.id, email: row.customer_email } : null;
}

// --- Sessions (signed cookie, stateless) --------------------------------------
//
// Same mechanism as integrators.ts, via crypto.ts's shared helpers — a
// distinct cookie name that also serves as the signing domain, so this
// session can never be replayed against /integrator/* routes or vice versa,
// even though both share the SESSION_SECRET Worker secret.

const CUSTOMER_SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CUSTOMER_SESSION_COOKIE_NAME = "rose_customer_session";

/** A `Set-Cookie` header value that logs a homeowner in. The subject id is
 * the household id, not a separate customer id — a claimed household *is*
 * the account. */
export async function createCustomerSessionCookie(env: Env, householdId: string): Promise<string> {
  return createSignedCookie(
    env.SESSION_SECRET,
    CUSTOMER_SESSION_COOKIE_NAME,
    CUSTOMER_SESSION_COOKIE_NAME,
    householdId,
    CUSTOMER_SESSION_DURATION_MS
  );
}

export function clearCustomerSessionCookie(): string {
  return clearSignedCookie(CUSTOMER_SESSION_COOKIE_NAME);
}

export function extractCustomerSessionCookie(request: Request): string | null {
  return extractCookie(request, CUSTOMER_SESSION_COOKIE_NAME);
}

/** Verify a customer session cookie and return the household id it
 * authenticates, or null if missing, malformed, expired, or tampered with. */
export async function verifyCustomerSessionCookie(env: Env, cookieValue: string | null): Promise<string | null> {
  return verifySignedCookie(env.SESSION_SECRET, CUSTOMER_SESSION_COOKIE_NAME, cookieValue);
}
