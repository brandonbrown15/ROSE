import type { Env } from "./index";
import { bytesToHex, hashSecret, hexToBytes, timingSafeEqual, verifySecret } from "./crypto";

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
// No sessions table — the cookie carries who and until-when, signed with
// SESSION_SECRET (a Worker secret) via HMAC-SHA256 so it can't be forged or
// tampered with, and stateless so an authenticated request doesn't need its
// own D1 round trip beyond whatever the request was already doing. The
// tradeoff: a session can't be revoked early (e.g. "log out everywhere")
// short of rotating SESSION_SECRET, which invalidates every session at
// once. Worth a real sessions table if per-session revocation ever matters
// (e.g. a "log out this device" button) — not needed yet.

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_COOKIE_NAME = "rose_session";

async function signSession(payload: string, secretHex: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", hexToBytes(secretHex), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return bytesToHex(new Uint8Array(sig));
}

/** A `Set-Cookie` header value that logs an integrator in. */
export async function createSessionCookie(env: Env, integratorId: string): Promise<string> {
  const expiresAt = Date.now() + SESSION_DURATION_MS;
  const payload = `${integratorId}.${expiresAt}`;
  const sig = await signSession(payload, env.SESSION_SECRET);
  return `${SESSION_COOKIE_NAME}=${payload}.${sig}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${
    SESSION_DURATION_MS / 1000
  }`;
}

/** A `Set-Cookie` header value that logs an integrator out. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Pull the raw session cookie value out of a request's Cookie header, if
 * present — pass the result to verifySessionCookie. */
export function extractSessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}

/** Verify a session cookie value and return the integrator id it
 * authenticates, or null if missing, malformed, expired, or tampered with. */
export async function verifySessionCookie(env: Env, cookieValue: string | null): Promise<string | null> {
  if (!cookieValue) {
    return null;
  }

  const parts = cookieValue.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [integratorId, expiresAtStr, sig] = parts;

  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    return null;
  }

  const expectedSig = await signSession(`${integratorId}.${expiresAtStr}`, env.SESSION_SECRET);
  return timingSafeEqual(sig, expectedSig) ? integratorId : null;
}
