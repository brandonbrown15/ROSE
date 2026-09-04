// Shared low-level crypto helpers, scoped to exactly what ROSE needs — not a
// general-purpose crypto library. Two distinct needs:
//
// 1. One-way hashing (PBKDF2-SHA256) for secrets ROSE only ever needs to
//    *check*, never read back: a household's admin PIN (households.ts) and
//    an integrator's login password (integrators.ts).
// 2. Reversible encryption (AES-256-GCM) for secrets ROSE needs to read back
//    in plaintext later: a household's own Home Assistant long-lived access
//    token (households.ts) — unlike a PIN or password, there's no way to
//    call Home Assistant's API with just a hash of the token.

const PBKDF2_ITERATIONS = 100_000;

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Constant-time string comparison — an early-exit `===` would leak how many
 * leading characters of a guess matched the real value via timing, which
 * defeats the point of hashing a low-entropy secret (a 4-8 digit PIN) in
 * the first place. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function derivePbkdf2Hash(secret: string, saltHex: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

/** Hash a new secret (a PIN or a login password) with a freshly generated
 * salt. Returns both — the caller stores both columns. */
export async function hashSecret(secret: string): Promise<{ hash: string; salt: string }> {
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await derivePbkdf2Hash(secret, salt);
  return { hash, salt };
}

/** Check a candidate secret against a previously stored hash+salt. */
export async function verifySecret(secret: string, salt: string, expectedHash: string): Promise<boolean> {
  const candidate = await derivePbkdf2Hash(secret, salt);
  return timingSafeEqual(candidate, expectedHash);
}

// --- Reversible encryption (AES-256-GCM) -----------------------------------
//
// Keyed by a single Worker secret (ENCRYPTION_KEY — 32 random bytes as 64
// hex chars, see docs/cloudflare.md), the same key for every household.
// Whoever can reach the Worker's own secrets can decrypt — the same trust
// boundary as every other secret in this codebase, not a new one.

async function importEncryptionKey(keyHex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", hexToBytes(keyHex), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypt a plaintext secret for storage. `keyHex` is the Worker's
 * ENCRYPTION_KEY secret. Returns one hex string — a random 12-byte IV
 * followed by the ciphertext — safe to store in a single TEXT column. The
 * IV isn't sensitive on its own; it just must never repeat for the same
 * key, which a fresh crypto.getRandomValues() call on every encryption
 * guarantees in practice. */
export async function encryptSecret(plaintext: string, keyHex: string): Promise<string> {
  const key = await importEncryptionKey(keyHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return bytesToHex(iv) + bytesToHex(new Uint8Array(ciphertext));
}

/** Decrypt a value produced by encryptSecret. Returns null (rather than
 * throwing) on any failure — a corrupted value or wrong key should degrade
 * to "not configured", not crash the request that needed it. */
export async function decryptSecret(packed: string, keyHex: string): Promise<string | null> {
  try {
    const key = await importEncryptionKey(keyHex);
    const bytes = hexToBytes(packed);
    const iv = bytes.slice(0, 12);
    const ciphertext = bytes.slice(12);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

// --- Signed session cookies (stateless) --------------------------------------
//
// Shared by every login system in ROSE that needs a browser session:
// integrators.ts (dealer/installer dashboard) and customers.ts (homeowner
// billing portal) so far. Both sign with the same SESSION_SECRET Worker
// secret, so the cookie name alone isn't what keeps them apart — the
// `domain` string below is mixed into the signed payload itself, so a
// stolen integrator-session cookie value can't be replayed under the
// customer-portal's cookie name (or vice versa) even if an attacker changes
// which header it's sent as. Pass each caller's own cookie name as the
// domain: distinct per login system, so this doubles as that separation.
//
// Stateless by design (no sessions table): a session cookie carries who and
// until-when, HMAC-signed so it can't be forged or tampered with, and
// verifying one is pure computation — no D1 read. The tradeoff, same for
// every caller: a session can't be revoked early short of rotating
// SESSION_SECRET, which logs *everyone* (both integrators and customers)
// out at once. Fine until "log out this device" matters; a real sessions
// table is the fix then.

async function signPayload(payload: string, secretHex: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", hexToBytes(secretHex), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return bytesToHex(new Uint8Array(sig));
}

/** A `Set-Cookie` header value that logs a subject in under `cookieName`,
 * signed against `domain` (see the module comment above — pass the same
 * string used to verify it later, typically just `cookieName` itself). */
export async function createSignedCookie(
  secretHex: string,
  cookieName: string,
  domain: string,
  subjectId: string,
  durationMs: number
): Promise<string> {
  const expiresAt = Date.now() + durationMs;
  const payload = `${domain}:${subjectId}.${expiresAt}`;
  const sig = await signPayload(payload, secretHex);
  return `${cookieName}=${subjectId}.${expiresAt}.${sig}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${
    durationMs / 1000
  }`;
}

/** A `Set-Cookie` header value that logs a subject out of `cookieName`. */
export function clearSignedCookie(cookieName: string): string {
  return `${cookieName}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Pull a named cookie's raw value out of a request's Cookie header, if
 * present — pass the result to verifySignedCookie. */
export function extractCookie(request: Request, cookieName: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`));
  return match ? match[1] : null;
}

/** Verify a signed cookie value against the same `domain` it was created
 * with, returning the subject id it authenticates or null if missing,
 * malformed, expired, tampered with, or signed for a different domain. */
export async function verifySignedCookie(
  secretHex: string,
  domain: string,
  cookieValue: string | null
): Promise<string | null> {
  if (!cookieValue) {
    return null;
  }

  const parts = cookieValue.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [subjectId, expiresAtStr, sig] = parts;

  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    return null;
  }

  const expectedSig = await signPayload(`${domain}:${subjectId}.${expiresAtStr}`, secretHex);
  return timingSafeEqual(sig, expectedSig) ? subjectId : null;
}
