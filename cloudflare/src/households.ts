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

// --- Admin PIN -------------------------------------------------------------
//
// A second factor for high-risk device actions (see chat.ts's
// HIGH_RISK_SERVICES), independent of the bearer-token auth above and of
// who the conversation currently thinks is speaking (identify.ts's
// attribution is entirely self-reported — see docs/memory.md). One shared
// PIN per household, the same mental model as a real alarm panel code, not
// per-person — simpler, and the point is gating an action, not identifying
// who did it.
//
// PBKDF2-SHA256, salted per household, never stored or logged in plaintext.
// A 4-8 digit PIN is low-entropy by nature (a real alarm-panel code, not a
// password) — PBKDF2's iteration count buys some protection against an
// offline guess against a leaked hash, but the real defense against online
// guessing is that every attempt costs a full conversational turn through
// the model; there's no rate-limiting here yet beyond that. Worth adding if
// this ever needs to withstand a scripted attacker with a valid bearer
// token calling /chat directly.
const PBKDF2_ITERATIONS = 100_000;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function derivePinHash(pin: string, saltHex: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

/** Constant-time string comparison — an early-exit `===` would leak how
 * many leading hex characters of a guess matched the real hash via timing,
 * which defeats the point of hashing a low-entropy secret in the first
 * place. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Set (or change) a household's admin PIN. There's no confirmation step or
 * old-PIN check here — this is only reachable via the household's own
 * bearer token (see index.ts's `POST /admin/pin`), which is already the
 * thing that gates who can do this. */
export async function setHouseholdPin(env: Env, householdId: string, pin: string): Promise<void> {
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await derivePinHash(pin, salt);
  await env.DB.prepare(`UPDATE households SET admin_pin_hash = ?1, admin_pin_salt = ?2 WHERE id = ?3`)
    .bind(hash, salt, householdId)
    .run();
}

/** Check a candidate PIN against the household's stored one. False for a
 * household that hasn't set a PIN up yet — deliberately "deny", not
 * "allow", so a household is never silently unprotected just because
 * nobody's configured this. */
export async function verifyHouseholdPin(env: Env, householdId: string, pin: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT admin_pin_hash, admin_pin_salt FROM households WHERE id = ?1`)
    .bind(householdId)
    .first<{ admin_pin_hash: string | null; admin_pin_salt: string | null }>();

  if (!row?.admin_pin_hash || !row.admin_pin_salt) {
    return false;
  }

  const candidate = await derivePinHash(pin, row.admin_pin_salt);
  return timingSafeEqual(candidate, row.admin_pin_hash);
}
