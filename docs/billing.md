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

## Pricing

Two Stripe Prices, GBP, both recurring monthly:

| | Price | What it gets you |
|---|---|---|
| **ROSE Assistant** (base) | £10/month | The chat assistant, memory, Home Assistant device control, admin PIN — everything else in this repo. |
| **Boreas Heating and Cooling Optimisation** (add-on) | +£15/month | Keeps the home at its chosen comfort temperature as cheaply as possible — heating or cooling, whichever's installed — against live Octopus Agile prices and the weather forecast. See [`energy.md`](energy.md). Priced to undercut Homely's £20/month equivalent. |

A household always subscribes to the base price; the Boreas add-on is
opt-in, chosen at signup (see `POST /portal/billing/start-subscription`
below) — both live as separate line items on one Stripe subscription, so
there's one invoice and one card charge either way, not two. The add-on
only actually does anything once the household's heat pump has also been
technically configured by its integrator (`energy.md`'s
`POST /integrator/households/:id/energy`) — paying for it before that's
done just means it activates the moment that setup finishes, nothing
breaks either order.

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

Session-authed. `{ "email": "...", "subscription_status": "active" | "past_due" | "canceled" | ... | null, "heating_addon_active": true | false }`.
`subscription_status: null` means this household has never started a
subscription. `heating_addon_active` is whether the Boreas add-on's
price is currently a line item on this household's subscription — see
[Enforcement](#enforcement) for why that alone isn't quite the same as "is
actually running."

### `GET /portal/config`

Unauthenticated — returns `{ "publishable_key": "pk_test_..." | null }`.
Stripe publishable keys are meant to be public (they ship in every
Stripe-integrated site's client-side JS), so this needs no session; `null`
means billing isn't configured on this Worker yet, and the portal page
shows a plain "not set up" message instead of trying to load Stripe.js.

### `POST /portal/billing/start-subscription`

Session-authed. `{ "include_heating": true | false }` (defaults to
`false`). Creates a Stripe Customer for the household if it doesn't have
one yet, starts a Subscription in Stripe's ["incomplete" flow for custom
UIs](https://stripe.com/docs/billing/subscriptions/build-subscriptions?ui=elements)
with the base price as one line item and, if requested, the heating
add-on price as a second, and returns `{ "client_secret": "..." }` — the
first invoice's PaymentIntent, which the portal page confirms client-side
with Stripe.js (`stripe.confirmCardPayment`). Card details never reach
this Worker at all.

`subscription_status` does **not** flip to `active` from this call — Stripe
hasn't actually charged the card yet at this point, just created the
invoice. It flips once the webhook below reports success. `heating_addon_active`
*is* written optimistically here (the moment the homeowner chooses it, not
once payment confirms) — see [Enforcement](#enforcement) for why that's
safe: nothing acts on it without `subscription_status` also being genuinely
`active`/`trialing`, which the webhook alone controls.

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
`households.subscription_status` **and** `heating_addon_active` in D1 in
sync with reality — nothing else does, so a Worker with the wrong (or no)
webhook secret configured will show both stuck on whatever their initial
state was. `heating_addon_active` is computed by checking whether
`STRIPE_HEATING_PRICE_ID` appears among the subscription's line items in
the event payload (always `false` on `customer.subscription.deleted`,
regardless of items).

## Enforcement

**`/chat` is gated** for households that engaged billing and then lapsed:

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
subscription and then it lapses. `/admin/pin` isn't gated at all.

**The Boreas add-on (`/energy/run` and the scheduled cron) is gated
differently** — see `households.ts`'s `listHouseholdsReadyForEnergyOptimization`:
a household needs BOTH `heating_addon_active` true AND `subscription_status`
genuinely `active`/`trialing` (not just "not past_due"), unless it's the
bootstrap `default` household. The extra check matters because
`start-subscription` writes `heating_addon_active` the moment a homeowner
*chooses* the add-on, before Stripe has actually confirmed the card — so
checking `subscription_status` too is what stops a real heat pump from
being touched before payment's actually gone through. `GET /energy/status`
isn't gated (nothing to bill for, just shows `{"enabled": false}` if
there's no config yet); `POST /energy/run` mirrors the cron's gate,
returning `409` if the household has no heat pump config at all, `402` if
it's configured but the add-on isn't genuinely active.

## Setting it up

Five Worker secrets/vars, none required for anything else in ROSE to keep
working:

1. **`STRIPE_SECRET_KEY`** (secret) — from Stripe's dashboard, **Developers
   → API keys**. Test mode (`sk_test_...`) first; switch to live
   (`sk_live_...`) only once you've actually tested a real subscription
   end to end.
2. **`STRIPE_PUBLISHABLE_KEY`** (plain var is fine — it's meant to be
   public) — same page, `pk_test_...` / `pk_live_...`.
3. **`STRIPE_CHAT_PRICE_ID`** and **`STRIPE_HEATING_PRICE_ID`** (secret or
   var, doesn't matter which — they're pointers, not credentials, same
   reasoning as a D1 `database_id`) — from **Product catalog → Add
   product**, one recurring GBP price each (see [Pricing](#pricing) for
   the amounts).
4. **`STRIPE_WEBHOOK_SECRET`** (secret) — from **Developers → Webhooks →
   Add endpoint**, pointed at `https://<your-worker>.workers.dev/billing/webhook`.
   Stripe only gives you this once the endpoint exists to register, so it's
   the last of the five you'll set.

`npx wrangler secret put <NAME>` for secrets, or the Cloudflare dashboard's
**Settings → Variables and Secrets**; either way, never commit real values
to this repo or paste them anywhere other than directly into Cloudflare.

## What this deliberately doesn't do (yet)

- **No plan changes, cancellation, or "update card" flow** from the
  portal — only the very first subscribe, and only choosing the heating
  add-on at that point (no "add it later" once already subscribed to just
  the base). A homeowner who needs to cancel, swap cards, or add the
  add-on after the fact today does it from the Stripe customer portal
  directly (if you've enabled it in the Stripe dashboard) or you do it by
  hand from Stripe's dashboard on their behalf.
- **No proration, trials, or coupons** — flat recurring prices, Stripe's
  defaults for everything else.
- **No dunning beyond Stripe's own retry schedule** — a `past_due`
  household just sees `/chat` refuse to respond until the card succeeds
  (Stripe retries automatically) or the homeowner updates it via Stripe's
  own hosted flows.
- **`/admin/pin` isn't gated** — only `/chat` and the Boreas add-on are,
  by design (see [Enforcement](#enforcement) above).
