import type { Env } from "./index";
import { bytesToHex, decryptSecret, encryptSecret, hashSecret, timingSafeEqual, verifySecret } from "./crypto";

export interface Household {
  id: string;
  name: string;
  // NULL: no subscription ever created for this household — never blocks
  // anything (see migration 0007's comment). Only 'past_due'/'canceled'
  // make index.ts refuse /chat. Always null on the ROSE_API_KEY fast path
  // below since that path never touches D1 — see its own comment.
  subscription_status?: string | null;
}

/**
 * Resolve a bearer token to the household it authenticates as, or null if
 * it doesn't match anything. Two paths:
 *
 *  - The token equals `env.ROSE_API_KEY` — the legacy single-tenant secret.
 *    Resolves to the bootstrap 'default' household (see migration 0003)
 *    without touching D1, so a deployment that predates multi-tenancy
 *    keeps working with its existing key unchanged. This also means
 *    subscription_status is always null here — if the 'default' household
 *    is ever billing-claimed too, a lapsed subscription won't be enforced
 *    against requests that authenticate via this legacy key specifically
 *    (only via its own households-table api_key, if it has one). Edge
 *    case, not a gap worth closing: 'default' is the bootstrap/operator
 *    household, not a paying customer's.
 *  - Otherwise, look it up in the `households` table — this is how every
 *    household added after multi-tenancy authenticates (see
 *    docs/households.md for how to add one).
 */
export async function resolveHousehold(env: Env, token: string): Promise<Household | null> {
  if (env.ROSE_API_KEY && token === env.ROSE_API_KEY) {
    return { id: "default", name: "Default household", subscription_status: null };
  }

  const row = await env.DB.prepare(`SELECT id, name, subscription_status FROM households WHERE api_key = ?1`)
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
// who did it. Hashing itself lives in crypto.ts, shared with integrators.ts's
// login passwords.

// A household with no PIN configured yet falls back to this rather than
// refusing every high-risk action outright — same idea as a router shipping
// with a default admin password: documented (docs/cloudflare.md), the same
// for every household until changed, and expected to actually get changed.
// Changing it (setHouseholdPin via POST /admin/pin) requires providing this
// current PIN first, same as changing any other PIN — see index.ts.
const DEFAULT_PIN = "1003";

/** Set (or change) a household's admin PIN. No confirmation step or old-PIN
 * check happens *here* — index.ts's `POST /admin/pin` handler is
 * responsible for calling `verifyHouseholdPin` against the caller-supplied
 * current PIN before ever calling this, so by the time this runs, that's
 * already been checked. This function just writes the new one. */
export async function setHouseholdPin(env: Env, householdId: string, pin: string): Promise<void> {
  const { hash, salt } = await hashSecret(pin);
  await env.DB.prepare(`UPDATE households SET admin_pin_hash = ?1, admin_pin_salt = ?2 WHERE id = ?3`)
    .bind(hash, salt, householdId)
    .run();
}

/** Check a candidate PIN against the household's stored one — or, if none
 * has been set up yet, against DEFAULT_PIN. */
export async function verifyHouseholdPin(env: Env, householdId: string, pin: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT admin_pin_hash, admin_pin_salt FROM households WHERE id = ?1`)
    .bind(householdId)
    .first<{ admin_pin_hash: string | null; admin_pin_salt: string | null }>();

  if (!row?.admin_pin_hash || !row.admin_pin_salt) {
    return timingSafeEqual(pin, DEFAULT_PIN);
  }

  return verifySecret(pin, row.admin_pin_salt, row.admin_pin_hash);
}

// --- Per-household Home Assistant connection --------------------------------
//
// Each household can configure its own Home Assistant instance — necessary
// once more than one household exists (see migration 0006's comment): a
// global HA_URL/HA_TOKEN Worker secret only ever made sense for a single
// household. The token is encrypted at rest (crypto.ts), not hashed, since
// ROSE genuinely needs it back in plaintext to call HA's API — unlike the
// PIN above.

export interface HouseholdHaConfig {
  url: string;
  token: string;
}

/** A household's own Home Assistant connection, decrypted — or null if
 * nothing usable is configured. Falls back to the legacy global
 * env.HA_URL/env.HA_TOKEN Worker secrets ONLY for the bootstrap 'default'
 * household (migration 0003), so an existing single-tenant deployment keeps
 * working unchanged; every household added since configures its own. */
export async function getHouseholdHaConfig(env: Env, householdId: string): Promise<HouseholdHaConfig | null> {
  const row = await env.DB.prepare(`SELECT ha_url, ha_token_encrypted FROM households WHERE id = ?1`)
    .bind(householdId)
    .first<{ ha_url: string | null; ha_token_encrypted: string | null }>();

  if (row?.ha_url && row.ha_token_encrypted && env.ENCRYPTION_KEY) {
    const token = await decryptSecret(row.ha_token_encrypted, env.ENCRYPTION_KEY);
    if (token) {
      return { url: row.ha_url, token };
    }
  }

  if (householdId === "default" && env.HA_URL && env.HA_TOKEN) {
    return { url: env.HA_URL, token: env.HA_TOKEN };
  }

  return null;
}

/** Set (or clear, passing null) a household's own Home Assistant connection. */
export async function setHouseholdHaConfig(
  env: Env,
  householdId: string,
  config: HouseholdHaConfig | null
): Promise<void> {
  if (!config) {
    await env.DB.prepare(`UPDATE households SET ha_url = NULL, ha_token_encrypted = NULL WHERE id = ?1`)
      .bind(householdId)
      .run();
    return;
  }

  if (!env.ENCRYPTION_KEY) {
    throw new Error("ENCRYPTION_KEY is not configured — cannot store a Home Assistant token");
  }

  const encrypted = await encryptSecret(config.token, env.ENCRYPTION_KEY);
  await env.DB.prepare(`UPDATE households SET ha_url = ?1, ha_token_encrypted = ?2 WHERE id = ?3`)
    .bind(config.url, encrypted, householdId)
    .run();
}

// --- Integrator-managed households ------------------------------------------
//
// See integrators.ts and docs/integrators.md for the dealer/installer layer
// these belong to.

/** Households belonging to one integrator, newest first. */
export async function listIntegratorHouseholds(env: Env, integratorId: string): Promise<Household[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, name FROM households WHERE integrator_id = ?1 ORDER BY created_at DESC`
  )
    .bind(integratorId)
    .all<Household>();
  return results;
}

/** True if this household belongs to this integrator — every integrator-
 * scoped endpoint that acts on a specific household (setting its HA
 * connection, etc.) checks this first, so one integrator can never read or
 * change another integrator's household by guessing its id. */
export async function householdBelongsToIntegrator(
  env: Env,
  householdId: string,
  integratorId: string
): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 FROM households WHERE id = ?1 AND integrator_id = ?2`)
    .bind(householdId, integratorId)
    .first();
  return row !== null;
}

/** Create a new household under an integrator, generating its bearer token
 * (the same `api_key` mechanism /chat authenticates with — see
 * resolveHousehold above). Returns the household with that key in
 * plaintext — the only time it's available that way, same as any generated
 * credential; the integrator dashboard shows it once, at creation. */
export async function createHousehold(
  env: Env,
  integratorId: string,
  name: string
): Promise<Household & { api_key: string }> {
  const id = crypto.randomUUID();
  const apiKey = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

  await env.DB.prepare(`INSERT INTO households (id, name, api_key, integrator_id) VALUES (?1, ?2, ?3, ?4)`)
    .bind(id, name, apiKey, integratorId)
    .run();

  return { id, name, api_key: apiKey };
}

// --- Billing (Stripe) ---------------------------------------------------
//
// See customers.ts for the homeowner-facing account/claim flow this
// belongs to, stripe.ts for the actual Stripe API calls, and
// docs/billing.md for the full picture. These are just the D1 reads/writes
// index.ts's /portal/billing/* and /billing/webhook handlers need.

export interface HouseholdBilling {
  customerEmail: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus: string | null;
}

export async function getHouseholdBilling(env: Env, householdId: string): Promise<HouseholdBilling | null> {
  const row = await env.DB.prepare(
    `SELECT customer_email, stripe_customer_id, stripe_subscription_id, subscription_status FROM households WHERE id = ?1`
  )
    .bind(householdId)
    .first<{
      customer_email: string | null;
      stripe_customer_id: string | null;
      stripe_subscription_id: string | null;
      subscription_status: string | null;
    }>();
  if (!row) return null;
  return {
    customerEmail: row.customer_email,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    subscriptionStatus: row.subscription_status,
  };
}

export async function setHouseholdStripeCustomer(env: Env, householdId: string, stripeCustomerId: string): Promise<void> {
  await env.DB.prepare(`UPDATE households SET stripe_customer_id = ?1 WHERE id = ?2`)
    .bind(stripeCustomerId, householdId)
    .run();
}

export async function setHouseholdSubscription(
  env: Env,
  householdId: string,
  stripeSubscriptionId: string,
  status: string
): Promise<void> {
  await env.DB.prepare(`UPDATE households SET stripe_subscription_id = ?1, subscription_status = ?2 WHERE id = ?3`)
    .bind(stripeSubscriptionId, status, householdId)
    .run();
}

/** Look up a household by its Stripe customer id — how the webhook handler
 * (index.ts's POST /billing/webhook) maps a Stripe event back to a
 * household, since Stripe's payloads carry Stripe's own ids, not ours. */
export async function findHouseholdByStripeCustomerId(env: Env, stripeCustomerId: string): Promise<Household | null> {
  const row = await env.DB.prepare(`SELECT id, name FROM households WHERE stripe_customer_id = ?1`)
    .bind(stripeCustomerId)
    .first<Household>();
  return row ?? null;
}

/** Update subscription_status by Stripe subscription id rather than
 * household id — some webhook event types carry the subscription id more
 * directly than the customer id in the payload shape index.ts reads. */
export async function updateSubscriptionStatusBySubscriptionId(
  env: Env,
  stripeSubscriptionId: string,
  status: string
): Promise<void> {
  await env.DB.prepare(`UPDATE households SET subscription_status = ?1 WHERE stripe_subscription_id = ?2`)
    .bind(status, stripeSubscriptionId)
    .run();
}
