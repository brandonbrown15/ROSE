import { timingSafeEqual } from "./crypto";

// A minimal Stripe REST API client — no SDK. Stripe's official Node SDK
// isn't built for the Workers runtime (it shells out to Node's `https`
// module internally); every call here is a plain `fetch` against Stripe's
// REST API instead, authenticated the way Stripe's own docs describe for
// any HTTP client: the secret key as the HTTP Basic Auth username, empty
// password. Scoped to exactly what ROSE's billing flow needs (see
// docs/billing.md) — not a general-purpose Stripe client.

const STRIPE_API_BASE = "https://api.stripe.com/v1";

function authHeader(secretKey: string): string {
  return "Basic " + btoa(`${secretKey}:`);
}

// Stripe's API takes application/x-www-form-urlencoded bodies with
// bracketed keys for nested fields (e.g. "items[0][price]"), not JSON —
// callers pass already-bracketed keys, this just encodes the values.
function formEncode(params: Record<string, string>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    usp.set(key, value);
  }
  return usp.toString();
}

interface StripeErrorBody {
  error?: { message?: string; type?: string };
}

async function stripeRequest<T>(secretKey: string, method: string, path: string, params?: Record<string, string>): Promise<T> {
  const res = await fetch(`${STRIPE_API_BASE}${path}`, {
    method,
    headers: {
      authorization: authHeader(secretKey),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params ? formEncode(params) : undefined,
  });

  const data = await res.json();
  if (!res.ok) {
    const message = (data as StripeErrorBody)?.error?.message ?? `Stripe API error (HTTP ${res.status})`;
    throw new Error(message);
  }
  return data as T;
}

export interface StripeCustomer {
  id: string;
}

/** Create a Stripe Customer for a household that doesn't have one yet.
 * Tags it with the household id in metadata so a Stripe-side lookup (e.g.
 * from the dashboard, debugging a webhook) can trace back to it without a
 * D1 round trip. */
export async function createStripeCustomer(secretKey: string, email: string, householdId: string): Promise<StripeCustomer> {
  return stripeRequest<StripeCustomer>(secretKey, "POST", "/customers", {
    email,
    "metadata[household_id]": householdId,
  });
}

export interface StripeSubscription {
  id: string;
  status: string;
  latest_invoice?: {
    payment_intent?: {
      client_secret: string;
    };
  };
}

/** Start a subscription in Stripe's recommended "incomplete" flow for a
 * custom (non-Checkout) UI: create the subscription now, but don't require
 * a payment method up front — Stripe generates a first invoice and a
 * PaymentIntent for it, and returns that PaymentIntent's client_secret.
 * The frontend confirms *that* with Stripe.js (stripe.confirmCardPayment),
 * which both pays the first invoice and attaches the card as the
 * customer's default payment method for future renewals — see
 * billingUI.ts. The subscription stays "incomplete" in Stripe (and
 * subscription_status stays whatever it was in D1) until that confirmation
 * succeeds and a webhook tells us so (index.ts's POST /billing/webhook). */
export async function createStripeSubscription(secretKey: string, customerId: string, priceId: string): Promise<StripeSubscription> {
  return stripeRequest<StripeSubscription>(secretKey, "POST", "/subscriptions", {
    customer: customerId,
    "items[0][price]": priceId,
    payment_behavior: "default_incomplete",
    "expand[0]": "latest_invoice.payment_intent",
  });
}

// --- Webhook signature verification ------------------------------------------
//
// Stripe signs every webhook delivery with a `Stripe-Signature` header —
// `t=<unix timestamp>,v1=<hex HMAC-SHA256 of "timestamp.rawBody">` — so a
// forged POST to this endpoint (no other auth on it; see index.ts) can't
// masquerade as a real Stripe event. Verifying needs the *raw* request
// body text, not a parsed-then-restringified one — even whitespace
// differences would break the signature — so index.ts reads it as text
// before this, and only JSON.parses it after this returns true.

const WEBHOOK_TOLERANCE_SECONDS = 300; // 5 minutes, same default Stripe's own SDKs use

export async function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string
): Promise<boolean> {
  if (!signatureHeader) {
    return false;
  }

  const parts: Record<string, string> = {};
  for (const entry of signatureHeader.split(",")) {
    const [key, value] = entry.split("=");
    if (key && value) parts[key] = value;
  }
  const timestamp = parts["t"];
  const expectedSig = parts["v1"];
  if (!timestamp || !expectedSig) {
    return false;
  }

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > WEBHOOK_TOLERANCE_SECONDS) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  const actualSig = Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqual(actualSig, expectedSig);
}
