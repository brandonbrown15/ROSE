# Billing (Stripe)

A household's subscription is billed **directly to the homeowner**, not
through their integrator — a household is set up technically by whoever
installed it ([`integrators.md`](integrators.md)), but pays for the ROSE
service itself on its own, through a separate customer portal.

This is a third login system alongside the two `households.md` and
`integrators.md` already cover:

| | Who | How | Used for |
|---|---|---|---|
| Household bearer token | A household's own client (HA integration, chat page) | `Authorization: Bearer <api_key>` | `/chat`, `/admin/pin` |
| Integrator session | An integrator's dashboard | Signed, `HttpOnly` cookie | `/integrator/*` |
| Customer session | A homeowner's billing portal | Signed, `HttpOnly` cookie (different cookie, same signing mechanism) | `/portal/*` |

## Claiming a household

There's no separate invite system — a homeowner "claims" their household
for billing by proving they hold its existing `api_key` (the same one their
integrator already handed them for the chat page / Home Assistant, per
[`households.md`](households.md#adding-a-new-household)), then sets an
email + password so they don't need that key again just to check billing.
See `claimHousehold` in
[`cloudflare/src/customers.ts`](../cloudflare/src/customers.ts).

This all happens through the customer portal page at **`GET /portal`**
(`cloudflare/src/billingUI.ts`) — a browser page, not an API a homeowner is
expected to call directly.

## Sessions

Same stateless signed-cookie mechanism as integrator sessions
([`integrators.md`](integrators.md#sessions-signed-cookie-not-a-sessions-table)),
generalized into `crypto.ts`'s `createSignedCookie`/`verifySignedCookie` and
shared by both. They use the same `SESSION_SECRET` Worker secret but a
different cookie name, and that cookie name is mixed into what actually
gets signed — so a stolen integrator session cookie can't be replayed
against `/portal/*` (or vice versa) by just renaming it.

## API

### `POST /portal/signup`

```json
{ "api_key": "the household's existing access key", "email": "...", "password": "at least 8 characters" }
```

Claims the household and logs it in. `401` for an `api_key` that doesn't
resolve to any household; `409` if that household's already been claimed,
or the email's taken by a different one.

### `POST /portal/login`

```json
{ "email": "...", "password": "..." }
```

`401` on any mismatch (unknown email or wrong password — same response
either way, so a login attempt never reveals which).

### `POST /portal/logout`

No body. Clears the session cookie.

### `GET /portal/status`

Session-authed. `{ "email": "...", "subscription_status": "active" | "past_due" | "canceled" | ... | null }`.
`null` means this household has never started a subscription.

### `GET /portal/config`

Unauthenticated — returns `{ "publishable_key": "pk_test_..." | null }`.
Stripe publishable keys are meant to be public (they ship in every
Stripe-integrated site's client-side JS), so this needs no session; `null`
means billing isn't configured on this Worker yet, and the portal page
shows a plain "not set up" message instead of trying to load Stripe.js.

### `POST /portal/billing/start-subscription`

Session-authed. No body. Creates a Stripe Customer for the household if it
doesn't have one yet, starts a Subscription in Stripe's ["incomplete" flow
for custom UIs](https://stripe.com/docs/billing/subscriptions/build-subscriptions?ui=elements),
and returns `{ "client_secret": "..." }` — the first invoice's
PaymentIntent, which the portal page confirms client-side with Stripe.js
(`stripe.confirmCardPayment`). Card details never reach this Worker at all.

`subscription_status` does **not** flip to `active` from this call — Stripe
hasn't actually charged the card yet at this point, just created the
invoice. It flips once the webhook below reports success.

### `POST /billing/webhook`

Not session-authed, not bearer-token-authed — Stripe calls this directly,
authenticated by its own signature scheme instead
(`Stripe-Signature` header, verified in `stripe.ts`'s
`verifyStripeWebhookSignature` against the `STRIPE_WEBHOOK_SECRET` Worker
secret). Register this URL in the Stripe dashboard
(**Developers → Webhooks → Add endpoint**) once the Worker's deployed, for
at least: `customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`, `invoice.payment_succeeded`,
`invoice.payment_failed`. This is what actually keeps
`households.subscription_status` in D1 in sync with reality — nothing else
does, so a Worker with the wrong (or no) webhook secret configured will
show subscriptions stuck on whatever their initial state was.

## Enforcement

**Only `/chat` is gated**, and only for households that engaged billing and
then lapsed:

```ts
if (household.subscription_status === "past_due" || household.subscription_status === "canceled") {
  // 402, before handleChat ever runs
}
```

A household with `subscription_status = null` — every household that
exists today, and every household that never uses `/portal` — is
completely unaffected; nothing about chat, Home Assistant control, the
integrator dashboard, or anything else changes because this feature
exists. Enforcement only engages once a household has actually started a
subscription and then it lapses. `/admin/pin` and the energy endpoints
aren't gated at all.

## Setting it up

Four Worker secrets/vars, none required for anything else in ROSE to keep
working:

1. **`STRIPE_SECRET_KEY`** (secret) — from Stripe's dashboard, **Developers
   → API keys**. Test mode (`sk_test_...`) first; switch to live
   (`sk_live_...`) only once you've actually tested a real subscription
   end to end.
2. **`STRIPE_PUBLISHABLE_KEY`** (plain var is fine — it's meant to be
   public) — same page, `pk_test_...` / `pk_live_...`.
3. **`STRIPE_PRICE_ID`** (secret or var, doesn't matter which — it's a
   pointer, not a credential, same reasoning as a D1 `database_id`) — from
   **Product catalog → Add product**, set up as a recurring price.
4. **`STRIPE_WEBHOOK_SECRET`** (secret) — from **Developers → Webhooks →
   Add endpoint**, pointed at `https://<your-worker>.workers.dev/billing/webhook`.
   Stripe only gives you this once the endpoint exists to register, so it's
   the last of the four you'll set.

`npx wrangler secret put <NAME>` for secrets, or the Cloudflare dashboard's
**Settings → Variables and Secrets**; either way, never commit real values
to this repo or paste them anywhere other than directly into Cloudflare.

## What this deliberately doesn't do (yet)

- **No plan changes, cancellation, or "update card" flow** from the
  portal — only the very first subscribe. A homeowner who needs to cancel
  or swap cards today does it from the Stripe customer portal
  directly (if you've enabled it in the Stripe dashboard) or you do it by
  hand from Stripe's dashboard on their behalf.
- **No proration, trials, or coupons** — a single flat recurring price,
  Stripe's defaults for everything else.
- **No dunning beyond Stripe's own retry schedule** — a `past_due`
  household just sees `/chat` refuse to respond until the card succeeds
  (Stripe retries automatically) or the homeowner updates it via Stripe's
  own hosted flows.
- **`/admin/pin` and the energy endpoints aren't gated** — only `/chat` is,
  by design (see Enforcement above).
