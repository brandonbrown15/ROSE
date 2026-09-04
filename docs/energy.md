# Energy optimization (heat pump, solar, EV charging)

**Off by default, and each piece is independently optional.** A subsystem
that uses Octopus Agile's half-hourly electricity prices and a Met Office
weather forecast to decide when to preheat and when to coast a Samsung (or
any) heat pump — the same idea as Homely — plus two SolarEdge add-ons you
can layer in once that hardware exists: live solar surplus overriding the
heat pump schedule ("free heat beats cheap heat"), and solar-surplus-first
EV charging.

None of the three needs the others. Enable just heat pump scheduling today;
add solar and EV charging later, independently, once that's installed — see
[Enabling it](#enabling-it).

**Read this whole page before enabling it.** It changes your actual heating
based on external data ROSE doesn't control (a price API, a weather API,
your Wi-Fi). Everything here is designed to fail safe, but "safe" still
means "your heating did something you didn't expect once," not "nothing bad
can ever happen."

## How it decides — and how it doesn't

This is a **deterministic algorithm**, not an LLM making a judgment call
each cycle. Every 30 minutes (a Cloudflare Cron Trigger), the Worker:

1. Fetches the next 24h of Octopus Agile half-hourly prices.
2. Fetches an hourly outside-temperature forecast from Met Office.
3. Ranks each price slot by **price ÷ estimated heat pump efficiency**, not
   raw price — a heat pump's COP (coefficient of performance) drops as it
   gets colder outside, so "cheap electricity during a cold snap" isn't
   necessarily "cheap heat." The efficiency curve used
   (`approximateCop` in `cloudflare/src/energy.ts`) is a generic,
   widely-cited rule-of-thumb shape (~4.5 at 10°C, ~2.2 at -5°C) — **it is
   not your specific Samsung model's published COP curve.** Swap it for
   real manufacturer data for a meaningful accuracy improvement.
4. Classifies the cheapest third of slots as "preheat" (target = your
   configured max), the priciest third as "coast" (target = your configured
   min), and the rest as "hold" (target = the midpoint).
5. Applies the *current* slot's target to the heat pump via Home
   Assistant's `climate.set_temperature` service, and stores the whole plan
   in D1.

**This has no thermal model of your house.** It doesn't know your heat-loss
rate, insulation, or how long "coasting" actually holds a comfortable
temperature — it's a price/efficiency heuristic, not a simulation. Treat it
as a reasonable first version, not a finished optimizer. See
[Known limitations](#known-limitations--future-work) below.

### If solar is configured too

Each cycle also reads live power flow from SolarEdge's Monitoring API
(production vs. consumption right now — not a forecast; SolarEdge's API is
for monitoring, not prediction). If there's surplus (you're generating more
than the house is using), that **overrides the price-based target to max**
for this cycle — using power you're already generating for free always
beats a merely-cheap grid price. This is reactive to the current reading
only; it doesn't plan ahead the way the price schedule does.

### If EV charging is configured too

Same live surplus reading decides whether the EV charger should be running:
above your configured surplus threshold → start charging; below it → stop.
Solar-surplus-first only for now — it won't charge from cheap overnight
Agile slots the way the heat pump does. See
[EV charger control](#ev-charger-control--the-one-part-thats-not-a-direct-api-call) for why this goes through Home Assistant rather than
SolarEdge directly.

## Safety model

- **Hard-clamped, always.** Every target temperature is clamped to
  `[ROSE_HEATING_MIN_TEMP, ROSE_HEATING_MAX_TEMP]` before it's ever sent to
  the heat pump — the optimizer cannot pick a temperature outside the band
  you set, regardless of price.
- **Safety floor overrides cost.** If your room sensor reads below
  `ROSE_HEATING_MIN_TEMP` when a cycle runs, ROSE ignores the price schedule
  entirely and boosts to the max — comfort/safety always wins over saving
  money.
- **Off by default.** Nothing runs — no API calls, no control — unless
  `ENERGY_OPTIMIZATION_ENABLED` is explicitly set to `"true"` *and* every
  required field below is set. Missing config = no-op, not a guess.
- **A failed cycle does nothing, on purpose.** If Octopus, Met Office,
  SolarEdge, or Home Assistant is unreachable, that cycle logs an error and
  changes nothing for that piece — it never falls back to guessing. The
  next cycle (30 min later) just tries again. A failed solar/EV read never
  blocks the heat pump plan running, and vice versa — they're independent.
- **Solar and EV are additive, never more permissive.** A solar surplus can
  only push the heat pump *up to* your configured max — same ceiling as
  everything else, never above it. EV charging only ever starts/stops; ROSE
  never adjusts charge current or anything else about the charger.
- **Test manually before trusting the schedule.** See
  [Testing before you trust it](#testing-before-you-trust-it).

## EV charger control — the one part that's not a direct API call

SolarEdge doesn't publish an official API for starting/stopping their EV
charger. Every integration that does it — including the community
[solaredge-evcharger-ha](https://github.com/briadelour/solaredge-evcharger-ha)
project — reverse-engineers a private endpoint SolarEdge could change
without notice. That's not something to embed in the Worker as if it were
stable.

Instead, ROSE controls the charger the same way it controls the heat pump:
by calling a Home Assistant service. You install whatever HA integration
actually talks to your charger (the community one above, or your charger's
own if it has one), find the entity ID it exposes, and tell ROSE which
service to call to start and stop it
(`ROSE_EV_CHARGER_START_SERVICE`/`_STOP_SERVICE`, e.g. `switch.turn_on` /
`switch.turn_off` — whatever that integration actually exposes). If
SolarEdge changes their private API, the community integration absorbs
that, not ROSE — and this also means it isn't actually limited to SolarEdge
chargers; any charger controllable from Home Assistant works the same way.

## Prerequisites — the part that isn't automatable

Unlike the rest of ROSE's setup, this genuinely needs several manual steps
across three external services. Nothing in `scripts/setup.sh` can shortcut
these — they require accounts and values only you have.

### 1. Home Assistant must be reachable from the internet

This is the one most people miss. The Cloudflare Worker runs in Cloudflare's
cloud, not on your home network — it **cannot reach `homeassistant.local` or
a bare LAN IP.** You need one of:

- **Cloudflare Tunnel** (recommended — you're already on Cloudflare):
  install `cloudflared` on the machine running Home Assistant and point a
  tunnel at it. No router port-forwarding needed. See
  [Cloudflare's Tunnel docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).
- **Nabu Casa Cloud** — if you already pay for Nabu Casa remote access, its
  `https://<your-instance>.ui.nabu.casa` URL should also work for API calls,
  not just the UI.
- Your own reverse proxy with a valid HTTPS certificate.

Whichever you use, that public HTTPS URL is your `HA_URL`.

### 2. A Home Assistant long-lived access token

Home Assistant profile (click your name, bottom left) → **Security** →
**Long-Lived Access Tokens** → **Create Token**. This becomes `HA_TOKEN`.
(`HA_URL`/`HA_TOKEN` are the same optional pair `cloudflare/src/ha.ts`
already supports — this feature is what they're for.)

### 3. Your Octopus Agile region letter

A single letter, A–P, for your electricity distribution area — find it on
your Octopus account page, or by looking up your postcode against
[Octopus's regions](https://octopus.energy/agile/). This becomes
`OCTOPUS_REGION`. (Agile rate data itself is public — no Octopus API key
needed.)

### 4. A Met Office DataHub API key

Register at [datahub.metoffice.gov.uk](https://datahub.metoffice.gov.uk),
subscribe to the free **Site Specific Global Spot** plan (360 calls/day free
— this feature uses 48/day at the default 30-minute schedule, well within
that). Becomes `MET_OFFICE_API_KEY`. You'll also need your site's
`MET_OFFICE_LATITUDE`/`MET_OFFICE_LONGITUDE`.

### 5. Your heat pump's entity ID and a room temperature sensor

In Home Assistant, **Developer Tools → States**, find your Samsung heat
pump's `climate.*` entity ID (`ROSE_HEATPUMP_ENTITY_ID`) and a
`sensor.*` entity reporting the room's current temperature
(`ROSE_ROOM_TEMP_ENTITY_ID`).

### 6. Decide your comfort band

`ROSE_HEATING_MIN_TEMP` / `ROSE_HEATING_MAX_TEMP` in °C — the range the
optimizer is allowed to move the setpoint within. Start conservative (e.g.
18–21) until you trust it.

### 7. (Solar) A SolarEdge Monitoring API key and site ID

From your SolarEdge account: **Admin → Site Access → API Access** to
generate an API key, and your site ID is in the URL of your monitoring
portal dashboard. Becomes `SOLAREDGE_API_KEY` / `SOLAREDGE_SITE_ID`.

### 8. (EV charging) An HA integration for the charger, and its entity ID

Install whatever Home Assistant integration actually talks to your charger
(see [EV charger control](#ev-charger-control--the-one-part-thats-not-a-direct-api-call)
above), then find its entity ID and the start/stop services it exposes in
**Developer Tools → States** / **Actions**.

### 9. (EV charging) A surplus threshold

`ROSE_EV_CHARGER_SURPLUS_THRESHOLD_KW` — minimum solar surplus, in kW,
before ROSE starts charging (defaults to 1.4 if unset, a reasonable
minimum for a single-phase charger to actually draw current at all — most
EV chargers can't modulate below their minimum current, so a threshold set
too low will just mean it starts, immediately imports a little grid power
to make up the difference, and looks like it's not really "surplus-only").

## Enabling it

All of this is set as Worker secrets (`wrangler secret put`) — even the
non-sensitive ones like entity IDs, for consistency with the rest of ROSE's
setup. Heat pump, solar, and EV charging are independent — set only the
group(s) you actually have installed.

```bash
cd cloudflare

# Heat pump scheduling
npx wrangler secret put OCTOPUS_REGION            # e.g. C
npx wrangler secret put MET_OFFICE_API_KEY
npx wrangler secret put MET_OFFICE_LATITUDE
npx wrangler secret put MET_OFFICE_LONGITUDE
npx wrangler secret put ROSE_HEATPUMP_ENTITY_ID    # e.g. climate.living_room_heat_pump
npx wrangler secret put ROSE_ROOM_TEMP_ENTITY_ID   # e.g. sensor.living_room_temperature
npx wrangler secret put ROSE_HEATING_MIN_TEMP      # e.g. 18
npx wrangler secret put ROSE_HEATING_MAX_TEMP      # e.g. 21
npx wrangler secret put HA_URL                     # your tunnel/Nabu Casa URL, if not already set
npx wrangler secret put HA_TOKEN                   # if not already set

# Solar (once installed) — independent of the heat pump fields above
npx wrangler secret put SOLAREDGE_API_KEY
npx wrangler secret put SOLAREDGE_SITE_ID

# EV charging (once installed) — needs solar configured too
npx wrangler secret put ROSE_EV_CHARGER_ENTITY_ID
npx wrangler secret put ROSE_EV_CHARGER_START_SERVICE          # e.g. switch.turn_on
npx wrangler secret put ROSE_EV_CHARGER_STOP_SERVICE           # e.g. switch.turn_off
npx wrangler secret put ROSE_EV_CHARGER_SURPLUS_THRESHOLD_KW   # e.g. 1.4

# Last — this is what actually turns any of it on:
npx wrangler secret put ENERGY_OPTIMIZATION_ENABLED  # value: true

npm run deploy
```

Redeploy after setting secrets so the cron trigger picks them up.

## Testing before you trust it

Don't wait for the next scheduled cycle. Trigger one manually and check what
it *would* do:

```bash
curl -X POST https://<your-worker-url>/energy/run \
  -H "Authorization: Bearer <ROSE_API_KEY>"
```

This runs a real cycle immediately — including actually setting the heat
pump — and returns the full plan plus which slot was applied and why:

```json
{
  "applied": {
    "start": "2026-09-01T10:00:00Z", "end": "2026-09-01T10:30:00Z",
    "targetTempC": 21, "pencePerKwh": 12.3, "outsideTempC": 14.2,
    "estimatedCop": 4.1, "reason": "cheap/efficient slot — preheating"
  },
  "plan": [ /* full 24h schedule */ ],
  "solar": { "pvKw": 2.1, "loadKw": 0.6, "gridKw": -1.5, "batteryKw": null, "surplusKw": 1.5 },
  "evCharging": true
}
```

`solar`/`evCharging` are `null` if those pieces aren't configured — that's
expected and fine if you only have the heat pump set up so far.

Check `GET /energy/status` any time afterward for the currently-stored plan
and recent EV start/stop events, without triggering a new cycle:

```bash
curl https://<your-worker-url>/energy/status -H "Authorization: Bearer <ROSE_API_KEY>"
```

**Before relying on any of this**, confirm by hand:

- **`climate.set_temperature` actually does what you expect on your
  integration.** Some heat pump integrations want `hvac_mode` alongside
  `temperature`, or use `target_temp_high`/`target_temp_low` instead of a
  single `temperature` field. Test the exact service call in Home
  Assistant's **Developer Tools → Actions** first.
- **The Met Office temperature field parsed correctly.** `metoffice.ts`
  scans for a field name containing "temperature" defensively (Met Office's
  full API reference sits behind an account login this couldn't verify
  against in advance), but sanity-check `outsideTempC` in a `/energy/run`
  response against the actual forecast before trusting it.
- **`solar.pvKw`/`loadKw` look like real numbers**, not zero or `null`, once
  SolarEdge is generating — `solaredge.ts` unwraps SolarEdge's response
  defensively for the same reason as the Met Office client.
- **The EV start/stop service calls actually control the charger.** Test
  `ROSE_EV_CHARGER_START_SERVICE`/`_STOP_SERVICE` directly in Home
  Assistant's Developer Tools before trusting `/energy/run` to fire them —
  and remember this rests on an unofficial community integration (see
  above), so re-verify after updating it.

## Known limitations / future work

- **No real thermal model.** The optimizer doesn't know your house's
  heat-loss rate or how long a "coast" period actually holds temperature —
  it's a price/efficiency heuristic, not a simulation. A real improvement
  here would model heat loss from room temp history and outside temp, and
  optimize against that instead of a fixed one-third/one-third/one-third
  split.
- **Generic COP curve, not your Samsung model's.** Swap `approximateCop` in
  `cloudflare/src/energy.ts` for your unit's published performance data.
- **Single room, single heat pump.** No support yet for multiple zones or
  heat pumps.
- **No cost tracking against actual consumption.** This schedules based on
  price, but doesn't (yet) pull your actual meter consumption from Octopus's
  account API to show real £ saved.
- **No conversational control yet.** ROSE (the LLM) doesn't currently take
  instructions like "keep the office warmer this week" and feed them into
  the optimizer — the comfort band is a static config value, not something
  you can adjust by talking to it. That's a natural next step once the
  deterministic core is proven out.
- **Solar surplus is reactive, not forecast.** Unlike the price/weather
  plan, which looks 24h ahead, solar only reacts to the current live
  reading — it can't yet plan "wait until 1pm when the sun's out" the way
  it plans around Agile prices. Adding a solar forecast (e.g.
  forecast.solar) alongside the live reading is the natural next step.
- **EV charging has no price fallback.** It's solar-surplus-only — it won't
  charge from a cheap overnight Agile slot if there's no sun. Layering in
  "charge from cheap grid power if the battery's still low by a deadline
  you set" is future work, not built yet.
- **EV charger control rests on an unofficial, reverse-engineered API** (via
  whatever HA integration you choose) — see
  [EV charger control](#ev-charger-control--the-one-part-thats-not-a-direct-api-call).
  Treat start/stop as best-effort, not guaranteed, until SolarEdge (or your
  charger's vendor) publishes something official.
