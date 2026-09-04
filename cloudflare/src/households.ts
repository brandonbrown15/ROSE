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
  heatingAddonActive: boolean;
}

export async function getHouseholdBilling(env: Env, householdId: string): Promise<HouseholdBilling | null> {
  const row = await env.DB.prepare(
    `SELECT customer_email, stripe_customer_id, stripe_subscription_id, subscription_status, heating_addon_active
     FROM households WHERE id = ?1`
  )
    .bind(householdId)
    .first<{
      customer_email: string | null;
      stripe_customer_id: string | null;
      stripe_subscription_id: string | null;
      subscription_status: string | null;
      heating_addon_active: number;
    }>();
  if (!row) return null;
  return {
    customerEmail: row.customer_email,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    subscriptionStatus: row.subscription_status,
    heatingAddonActive: row.heating_addon_active === 1,
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
  status: string,
  heatingAddonActive: boolean
): Promise<void> {
  await env.DB.prepare(
    `UPDATE households SET stripe_subscription_id = ?1, subscription_status = ?2, heating_addon_active = ?3 WHERE id = ?4`
  )
    .bind(stripeSubscriptionId, status, heatingAddonActive ? 1 : 0, householdId)
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
 * household id — some webhook event types (invoice.payment_succeeded/
 * _failed) carry the subscription id more directly than the customer id in
 * the payload shape index.ts reads, and don't carry line items at all, so
 * this never touches heating_addon_active — see
 * updateSubscriptionAddonsBySubscriptionId for that. */
export async function updateSubscriptionStatusBySubscriptionId(
  env: Env,
  stripeSubscriptionId: string,
  status: string
): Promise<void> {
  await env.DB.prepare(`UPDATE households SET subscription_status = ?1 WHERE stripe_subscription_id = ?2`)
    .bind(status, stripeSubscriptionId)
    .run();
}

/** Update both subscription_status and heating_addon_active together, by
 * Stripe subscription id — what index.ts's webhook handler calls for
 * customer.subscription.* events, whose payload includes the full line-item
 * list, so it can tell whether the heating add-on price is actually on the
 * subscription right now (added, removed, or the whole subscription
 * canceled). */
export async function updateSubscriptionAddonsBySubscriptionId(
  env: Env,
  stripeSubscriptionId: string,
  status: string,
  heatingAddonActive: boolean
): Promise<void> {
  await env.DB.prepare(
    `UPDATE households SET subscription_status = ?1, heating_addon_active = ?2 WHERE stripe_subscription_id = ?3`
  )
    .bind(status, heatingAddonActive ? 1 : 0, stripeSubscriptionId)
    .run();
}

// --- Per-household heating optimization config -------------------------
//
// See migration 0008's comment: what used to be a single global heat pump
// config (one Worker, one home) is now per-household, reusing each
// household's own Home Assistant connection (getHouseholdHaConfig above).
// Solar/EV stay global/single-tenant for now — not sold as a billed add-on
// yet, see docs/energy.md.

// Octopus Agile is the only major UK supplier with a public, free, live
// half-hourly dynamic pricing API — every other tariff (Economy 7/10, OVO
// Charge Anytime, EDF GoElectric, a plain flat rate) has no equivalent to
// pull live, so "any tariff" (matching Homely's own claim, see
// docs/energy.md) means a manually entered schedule as the alternative,
// which the optimizer schedules against the same way, just without
// reacting to live price changes there aren't any of.

export interface OffPeakWindow {
  start: string; // "HH:MM", local time
  end: string; // "HH:MM", local time
  pence: number; // pence/kWh during this window
}

export type HouseholdTariff =
  | { type: "octopus_agile"; octopusRegion: string }
  | { type: "manual"; defaultPence: number; offPeakWindows: OffPeakWindow[] };

export interface HouseholdEnergyConfig {
  heatpumpEntityId: string;
  roomTempEntityId: string;
  minTempC: number;
  maxTempC: number;
  metOfficeLatitude: string;
  metOfficeLongitude: string;
  tariff: HouseholdTariff;
}

interface HouseholdEnergyRow {
  heatpump_entity_id: string | null;
  room_temp_entity_id: string | null;
  heating_min_temp_c: number | null;
  heating_max_temp_c: number | null;
  met_office_latitude: string | null;
  met_office_longitude: string | null;
  tariff_type: string;
  octopus_region: string | null;
  manual_tariff_default_pence: number | null;
  manual_tariff_off_peak_json: string | null;
}

/** Parses manual_tariff_off_peak_json, discarding anything malformed rather
 * than throwing — a corrupted or hand-edited value should degrade to "no
 * off-peak windows" (falls back to the flat default rate), not break the
 * whole optimizer for this household. */
function parseOffPeakWindows(json: string | null): OffPeakWindow[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (w): w is OffPeakWindow =>
        Boolean(w) && typeof w.start === "string" && typeof w.end === "string" && typeof w.pence === "number"
    );
  } catch {
    return [];
  }
}

function rowToEnergyConfig(row: HouseholdEnergyRow): HouseholdEnergyConfig | null {
  if (
    !row.heatpump_entity_id ||
    !row.room_temp_entity_id ||
    row.heating_min_temp_c === null ||
    row.heating_max_temp_c === null ||
    !row.met_office_latitude ||
    !row.met_office_longitude
  ) {
    return null;
  }

  let tariff: HouseholdTariff;
  if (row.tariff_type === "manual") {
    if (row.manual_tariff_default_pence === null) return null;
    tariff = {
      type: "manual",
      defaultPence: row.manual_tariff_default_pence,
      offPeakWindows: parseOffPeakWindows(row.manual_tariff_off_peak_json),
    };
  } else {
    if (!row.octopus_region) return null;
    tariff = { type: "octopus_agile", octopusRegion: row.octopus_region };
  }

  return {
    heatpumpEntityId: row.heatpump_entity_id,
    roomTempEntityId: row.room_temp_entity_id,
    minTempC: row.heating_min_temp_c,
    maxTempC: row.heating_max_temp_c,
    metOfficeLatitude: row.met_office_latitude,
    metOfficeLongitude: row.met_office_longitude,
    tariff,
  };
}

const ENERGY_ROW_COLUMNS = `heatpump_entity_id, room_temp_entity_id, heating_min_temp_c, heating_max_temp_c,
            met_office_latitude, met_office_longitude, tariff_type, octopus_region,
            manual_tariff_default_pence, manual_tariff_off_peak_json`;

/** A household's heating optimization config, or null if any required
 * field is missing — same "off unless every field is set" pattern as every
 * other optional feature in this codebase. Does NOT check billing — a
 * household can have this configured (by its integrator, during setup)
 * before ever subscribing to the heating add-on; index.ts checks
 * heating_addon_active separately before actually acting on it. */
export async function getHouseholdEnergyConfig(env: Env, householdId: string): Promise<HouseholdEnergyConfig | null> {
  const row = await env.DB.prepare(`SELECT ${ENERGY_ROW_COLUMNS} FROM households WHERE id = ?1`)
    .bind(householdId)
    .first<HouseholdEnergyRow>();
  return row ? rowToEnergyConfig(row) : null;
}

/** Set (or clear, passing null) a household's heating optimization config —
 * the integrator dashboard's technical-setup counterpart to
 * setHouseholdHaConfig, not something a homeowner enters themselves.
 * Always writes every tariff-related column (clearing whichever kind isn't
 * in use) so switching a household from one tariff type to the other never
 * leaves stale data behind from the previous type. */
export async function setHouseholdEnergyConfig(
  env: Env,
  householdId: string,
  config: HouseholdEnergyConfig | null
): Promise<void> {
  if (!config) {
    await env.DB.prepare(
      `UPDATE households SET heatpump_entity_id = NULL, room_temp_entity_id = NULL, heating_min_temp_c = NULL,
              heating_max_temp_c = NULL, met_office_latitude = NULL, met_office_longitude = NULL,
              tariff_type = 'octopus_agile', octopus_region = NULL,
              manual_tariff_default_pence = NULL, manual_tariff_off_peak_json = NULL
       WHERE id = ?1`
    )
      .bind(householdId)
      .run();
    return;
  }

  const octopusRegion = config.tariff.type === "octopus_agile" ? config.tariff.octopusRegion : null;
  const manualDefaultPence = config.tariff.type === "manual" ? config.tariff.defaultPence : null;
  const manualOffPeakJson = config.tariff.type === "manual" ? JSON.stringify(config.tariff.offPeakWindows) : null;

  await env.DB.prepare(
    `UPDATE households SET heatpump_entity_id = ?1, room_temp_entity_id = ?2, heating_min_temp_c = ?3,
            heating_max_temp_c = ?4, met_office_latitude = ?5, met_office_longitude = ?6, tariff_type = ?7,
            octopus_region = ?8, manual_tariff_default_pence = ?9, manual_tariff_off_peak_json = ?10
     WHERE id = ?11`
  )
    .bind(
      config.heatpumpEntityId,
      config.roomTempEntityId,
      config.minTempC,
      config.maxTempC,
      config.metOfficeLatitude,
      config.metOfficeLongitude,
      config.tariff.type,
      octopusRegion,
      manualDefaultPence,
      manualOffPeakJson,
      householdId
    )
    .run();
}

export interface HouseholdForEnergy {
  id: string;
  heatingAddonActive: boolean;
  energyConfig: HouseholdEnergyConfig;
}

/** Every household ready for a heat pump optimization cycle: technical
 * config fully set (whichever tariff type it uses) AND (the bootstrap
 * 'default' household, exempt from billing the same way it's exempt from
 * /chat's subscription gate — see index.ts — OR actually paying:
 * heating_addon_active AND subscription_status genuinely
 * 'active'/'trialing', not merely 'incomplete'). That second condition
 * matters — handlePortalStartSubscription writes heating_addon_active
 * optimistically the moment a homeowner *chooses* the add-on, before
 * Stripe has actually confirmed payment, so checking subscription_status
 * too is what stops the cron from touching a real heat pump before the
 * card's actually been charged. What the scheduled() cron loops over. */
export async function listHouseholdsReadyForEnergyOptimization(env: Env): Promise<HouseholdForEnergy[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, heating_addon_active, ${ENERGY_ROW_COLUMNS}
     FROM households
     WHERE heatpump_entity_id IS NOT NULL
       AND room_temp_entity_id IS NOT NULL
       AND heating_min_temp_c IS NOT NULL
       AND heating_max_temp_c IS NOT NULL
       AND met_office_latitude IS NOT NULL
       AND met_office_longitude IS NOT NULL
       AND (
         (tariff_type = 'octopus_agile' AND octopus_region IS NOT NULL)
         OR (tariff_type = 'manual' AND manual_tariff_default_pence IS NOT NULL)
       )
       AND (
         id = 'default'
         OR (heating_addon_active = 1 AND subscription_status IN ('active', 'trialing'))
       )`
  ).all<HouseholdEnergyRow & { id: string; heating_addon_active: number }>();

  return results
    .map((row) => {
      const energyConfig = rowToEnergyConfig(row);
      return energyConfig
        ? { id: row.id, heatingAddonActive: row.heating_addon_active === 1, energyConfig }
        : null;
    })
    .filter((h): h is HouseholdForEnergy => h !== null);
}
