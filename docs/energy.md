# Energy optimization (heat pump/AC, solar, EV charging)

**Off by default, and each piece is independently optional.** A subsystem
that uses live electricity prices and a Met Office weather forecast to
decide when to preheat/pre-cool and when to coast a Samsung (or any) heat
pump or air conditioner — the same idea as Homely, and priced to compete
with it directly (see [`billing.md`](billing.md#pricing)) — plus two
SolarEdge add-ons you can layer in once that hardware exists: live solar
surplus overriding the schedule ("free power beats cheap power"), and
solar-surplus-first EV charging.

**Heating or cooling, per household** — Home Assistant represents a heat
pump and an AC unit the same way (a `climate.*` entity,
`climate.set_temperature`), but the optimizer's *logic* is direction-
sensitive: cheap slots should push a heat pump's target **up** (preheat)
but an AC's target **down** (pre-cool), and the safety override needs to
boost heating when the room's too cold but boost cooling when it's too
hot. A household's `hvac_mode` (`"heat"`, `"cool"`, or `"auto"`, set
alongside its other heat pump/AC config — see [Enabling it](#enabling-it))
tells `energy.ts` which direction to reason in. Defaults to `"heat"` —
every household configured before this existed keeps behaving exactly as
it did.

**`"auto"` switches itself between the two by outdoor temperature** — the
realistic case for most UK homes, where AC is only needed a handful of
days a year and nobody wants to remember to flip a setting for it. Each
cycle checks the current/forecast outdoor temperature against two
configurable thresholds (defaulting to 18°C/24°C) with hysteresis between
them, so a borderline day doesn't flip the household back and forth —
see [Known limitations](#known-limitations--future-work).

**Two ways to actually reach the heat pump, per household** — a
household's `heatpump_control`:

- **`"home_assistant"`** (default) — everything above, via a household's
  own Home Assistant instance, as described throughout this page.
- **`"boreas_device"`** — a standalone Boreas unit (planned hardware, see
  [`boreas-device.md`](boreas-device.md)) instead of Home Assistant. Since
  the device sits behind the household's own home network/NAT, the Worker
  can't reach it directly the way it reaches a household's (publicly
  tunnelled) Home Assistant instance — control flips to the device
  periodically polling the Worker (`POST /device/checkin`) instead. See
  [Standalone Boreas devices](#standalone-boreas-devices-heatpump_control-boreas_device)
  below. Everything about *how the plan is computed* (price ranking,
  weather, `hvac_mode`, safety override) is identical either way; only
  where the room reading comes from and where the target temperature goes
  differs.

**Two ways to price the plan, per household**, since Homely's own claim is
"works with all tariffs" and matching that honestly needs both:

- **Octopus Agile** — live, half-hourly, fully automatic. Octopus is the
  only major UK supplier with a public, free API for genuinely dynamic
  pricing, so this is the "best" mode where it's available.
- **Any other supplier, manually** — the installer enters the household's
  actual tariff instead: a flat day rate, plus optional cheaper time-of-use
  windows (Economy 7/10, or whatever off-peak hours the tariff actually
  has). E.ON, ScottishPower, EDF, British Gas, OVO — none of them publish a
  live-pricing API the way Octopus does, so there's nothing to pull live;
  the optimizer schedules against the entered schedule instead, same
  algorithm, just without reacting to price changes there aren't any of.
  See [households.ts's `HouseholdTariff`](../cloudflare/src/households.ts)
  and [`manualTariff.ts`](../cloudflare/src/manualTariff.ts).

**Heat pump scheduling is per-household and billed as an add-on**
(`billing.md`); solar and EV charging are still single-tenant/global,
scoped to the bootstrap `default` household, and not sold as a billed
add-on yet. None of the three needs the others. Enable just heat pump
scheduling today; add solar and EV charging later, independently, once
that's installed — see [Enabling it](#enabling-it).

**Read this whole page before enabling it.** It changes your actual heating
based on external data ROSE doesn't control (a price API, a weather API,
your Wi-Fi). Everything here is designed to fail safe, but "safe" still
means "your heating did something you didn't expect once," not "nothing bad
can ever happen."

## How it decides — and how it doesn't

This is a **deterministic algorithm**, not an LLM making a judgment call
each cycle. Every 30 minutes (a Cloudflare Cron Trigger), the Worker:

1. Fetches the next 24h of prices — Octopus Agile's live half-hourly rates,
   or synthesized half-hourly slots from the household's manually entered
   schedule if it's on a different tariff (see above) — the same shape
   either way, so every step after this one doesn't care which.
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

- **Hard-clamped, always.** Every target temperature is clamped to your
  household's configured `[min, max]` band before it's ever sent to the
  heat pump — the optimizer cannot pick a temperature outside the band you
  set, regardless of price.
- **Safety override beats cost.** On heating, if your room sensor reads
  below the configured minimum when a cycle runs, ROSE ignores the price
  schedule entirely and boosts to the max. On cooling, the mirror image:
  above the configured maximum boosts cooling toward the min. Either way,
  comfort/safety always wins over saving money.
- **Off by default, and billing-gated per household.** Nothing runs for a
  household — no API calls, no control — unless `ENERGY_OPTIMIZATION_ENABLED`
  is set to `"true"` on the Worker, that household's technical config is
  fully set (below), AND either it's the bootstrap `default` household or
  it's actually paying for the add-on with an active subscription — see
  [`billing.md`](billing.md#enforcement). Missing config or unpaid = no-op,
  not a guess.
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
**Long-Lived Access Tokens** → **Create Token**. This is the same
`url`/`token` pair set per household via
[`POST /integrator/households/:id/ha`](integrators.md#managing-a-households-home-assistant-connection)
(or, for the bootstrap `default` household, the global `HA_URL`/`HA_TOKEN`
Worker secrets) — this feature reuses whichever Home Assistant connection
the household already has for device control, it doesn't need its own.

### 3. Your tariff

**On Octopus Agile:** a single letter, A–P, for your electricity
distribution area — find it on your Octopus account page, or by looking up
your postcode against [Octopus's regions](https://octopus.energy/agile/).
(Agile rate data itself is public — no Octopus API key needed.)

**On any other supplier:** your tariff's rates instead — the flat day rate
in pence/kWh, plus the start/end times and rate of any cheaper off-peak
window(s) it has (Economy 7 is typically one ~7h overnight window; a plain
fixed-rate tariff has none — just the flat rate). Check your bill or your
supplier's app for the exact numbers. Both set per-household via the
integrator dashboard (below).

### 4. A Met Office DataHub API key

Register at [datahub.metoffice.gov.uk](https://datahub.metoffice.gov.uk),
subscribe to the free **Site Specific Global Spot** plan (360 calls/day free
per household at the default 30-minute schedule — comfortably covers a
handful of households before you'd need to think about the free tier's
limit). Becomes the `MET_OFFICE_API_KEY` Worker secret — one account,
shared across every household, since it's your own developer account
rather than something each homeowner has. Each household's own forecast
location is set per-household via the dashboard (below) as a **UK
postcode** — the Worker resolves it to the lat/long the Met Office forecast
and this "auto" mode's temperature reading actually need, via
[postcodes.io](https://postcodes.io/) (free, no key, official ONS data), so
nobody has to go find their own decimal coordinates.

### 5. Your heat pump's entity ID and a room temperature sensor

In Home Assistant, **Developer Tools → States**, find the heat pump's
`climate.*` entity ID and a `sensor.*` entity reporting the room's current
temperature. Per-household, set via the dashboard.

**How that entity gets there is entirely between your heat pump and Home
Assistant — ROSE never talks to the manufacturer directly, only to
whatever HA already exposes as a `climate.*` entity.** For a Samsung EHS/HE/HT
heat pump, that's typically the genuine Samsung **MIM-B19N** module, which
sits on the outdoor unit and bridges Samsung's proprietary NASA (R1/R2) bus
to standard **Modbus RTU over RS485** — configured in HA via its built-in
Modbus integration, or a community component built specifically for the
MIM-B19N register set. One thing worth checking on-site: each indoor unit
needs **"Use of central control" (SEG5) set to "Use (1)"**, or the module
can read status but can't send control commands. Other manufacturers vary —
Daikin, Mitsubishi Ecodan, Vaillant, and Nibe units are more commonly
integrated via their own cloud APIs (MELCloud, sensoNET, Uplink, etc.)
rather than a local bus — but whichever protocol sits underneath, once HA
exposes a `climate.*` entity for it, it looks identical to ROSE.

### 6. Decide the comfort band

The min/max °C range the optimizer is allowed to move the setpoint within
for this household — start conservative (e.g. 18–21) until you trust it.
Per-household, set via the dashboard.

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

**Heat pump/AC scheduling** is per-household config, set the same way as a
household's Home Assistant connection — through the integrator dashboard
(`GET /dashboard`, see [`integrators.md`](integrators.md)), not Worker
secrets:

```
POST /integrator/households/:id/energy

# Heating, on Octopus Agile:
{
  "heatpump_entity_id": "climate.living_room_heat_pump",
  "room_temp_entity_id": "sensor.living_room_temperature",
  "min_temp_c": 18,
  "max_temp_c": 21,
  "postcode": "SW1A 1AA",
  "hvac_mode": "heat",
  "tariff_type": "octopus_agile",
  "octopus_region": "C"
}

# Cooling, on any other supplier:
{
  "heatpump_entity_id": "climate.living_room_aircon",
  "room_temp_entity_id": "sensor.living_room_temperature",
  "min_temp_c": 21,
  "max_temp_c": 25,
  "postcode": "SW1A 1AA",
  "hvac_mode": "cool",
  "tariff_type": "manual",
  "manual_default_pence": 28.5,
  "manual_off_peak_windows": [{ "start": "00:30", "end": "07:30", "pence": 15.0 }]
}

# Auto — switches itself between heating and cooling by outdoor temperature:
{
  "heatpump_entity_id": "climate.living_room_heat_pump",
  "room_temp_entity_id": "sensor.living_room_temperature",
  "min_temp_c": 18,
  "max_temp_c": 21,
  "postcode": "SW1A 1AA",
  "hvac_mode": "auto",
  "auto_heat_below_c": 18,
  "auto_cool_above_c": 24,
  "tariff_type": "octopus_agile",
  "octopus_region": "C"
}

# Standalone Boreas device instead of Home Assistant — no heatpump_entity_id/
# room_temp_entity_id at all; the device's own registration stands in for both
# (see "Standalone Boreas devices" below):
{
  "heatpump_control": "boreas_device",
  "min_temp_c": 18,
  "max_temp_c": 21,
  "postcode": "SW1A 1AA",
  "hvac_mode": "heat",
  "tariff_type": "octopus_agile",
  "octopus_region": "C"
}
```

`postcode` is resolved server-side, once, at save time — via
[postcodes.io](https://postcodes.io/), so a `curl` (or the dashboard form)
only ever needs a UK postcode, never decimal coordinates. The response
echoes back `resolved_postcode` in postcodes.io's own normalized casing, so
you can confirm it matched what you meant. A `400` means it didn't look
like a real UK postcode.

`hvac_mode` defaults to `"heat"` if omitted — matching every household
configured before this existed. `"heat"`/`"cool"` only flip which direction
the optimizer pushes toward (see the top of this doc); `"auto"` decides
that itself each cycle from outdoor temperature, via `auto_heat_below_c`/
`auto_cool_above_c` (both default to 18/24 if omitted, but only actually
matter in `"auto"` mode). None of the three ever switches the unit itself
between heating and cooling mode — that's still on the household's own
thermostat/app, same as any reversible heat pump today; ROSE only ever
pushes a target temperature within whatever mode the unit's already in.

`heatpump_control` defaults to `"home_assistant"` if omitted — matching
every household configured before this existed. Set it to `"boreas_device"`
to switch a household onto a standalone device instead; `heatpump_entity_id`/
`room_temp_entity_id` become optional (and are ignored if given) in that
mode. Switching this doesn't provision the device itself — that's the
separate call below — so setting `heatpump_control` to `"boreas_device"`
before a device has ever checked in just means the cron computes a plan
with nowhere to send it yet (see [Standalone Boreas
devices](#standalone-boreas-devices-heatpump_control-boreas_device)).

`manual_off_peak_windows` can be an empty array for a plain flat-rate
tariff, or list more than one window for something like Economy 10. A
window's `start`/`end` are local (UK clock) time, `"HH:MM"`, and correctly
handle the BST/GMT change; a window can wrap past midnight (e.g.
`"23:00"`–`"06:00"`).

The dashboard page has a form for this per household (a dropdown picks the
tariff type, switching which fields show) — no `curl` needed.
Setting this wires up the *how*; whether a household is actually billed to
run it is entirely separate (the homeowner subscribes to the add-on from
their own [billing portal](billing.md), `GET /portal`) — see
[Safety model](#safety-model) above for the full gate.

Three things stay Worker secrets/vars, set once for the whole deployment
rather than per household:

```bash
cd cloudflare

npx wrangler secret put MET_OFFICE_API_KEY           # your Met Office DataHub account
# Optional — Octopus's Agile product code is the same nationally; leave unset to auto-detect
npx wrangler secret put OCTOPUS_PRODUCT_CODE

# Solar (once installed) — still single-tenant/global, scoped to the
# 'default' household — see the note at the top of this doc
npx wrangler secret put SOLAREDGE_API_KEY
npx wrangler secret put SOLAREDGE_SITE_ID

# EV charging (once installed) — needs solar configured too
npx wrangler secret put ROSE_EV_CHARGER_ENTITY_ID
npx wrangler secret put ROSE_EV_CHARGER_START_SERVICE          # e.g. switch.turn_on
npx wrangler secret put ROSE_EV_CHARGER_STOP_SERVICE           # e.g. switch.turn_off
npx wrangler secret put ROSE_EV_CHARGER_SURPLUS_THRESHOLD_KW   # e.g. 1.4

# Last — this is the global kill switch that actually turns any of it on:
npx wrangler secret put ENERGY_OPTIMIZATION_ENABLED  # value: true

npm run deploy
```

The bootstrap `default` household is the one exception: it has no
integrator to log into the dashboard on its behalf, so `scripts/setup.sh`
writes its heat pump config straight into D1 (`wrangler d1 execute`)
instead, when you opt in during setup — see
[`households.md`](households.md#adding-a-new-household) for the same
"by hand" pattern applied elsewhere.

Redeploy after setting secrets so the cron trigger picks them up.

### Standalone Boreas devices (`heatpump_control: "boreas_device"`)

**Planned hardware — see [`boreas-device.md`](boreas-device.md) for the
full picture.** No physical unit exists yet; this is the Worker-side API
it'll call, built ahead of the hardware so firmware work isn't also
blocked on backend work.

Provisioning a device is a separate call from setting `heatpump_control`
above — same session-authed, ownership-checked pattern as the HA/energy
endpoints:

```
POST /integrator/households/:id/device
{ "name": "Living room Boreas unit" }   # optional

→ { "device": { "id": "...", "name": "...", "device_key": "..." } }
```

`device_key` is shown **once, in plaintext** — same as a household's own
`api_key` at creation (see [households.md](households.md)) — and is a
genuinely separate credential from that `api_key`: a device sitting in a
customer's consumer unit is a different physical-access risk than a phone
or a cloud service, so a compromised device can't be used to authenticate
as the household's chat/Home-Assistant client. Calling this again for a
household that already has a device **replaces** its key — the old one
stops working immediately.

The device itself then polls, roughly on whatever interval its firmware
decides (this doesn't dictate one yet):

```
POST /device/checkin
Authorization: Bearer <device_key>
{ "room_temp_c": 19.4 }

→ { "target_temp_c": 21, "hvac_mode": "heat" }
```

This reports the device's own room-temperature reading (replacing what a
`room_temp_entity_id` sensor would tell Home Assistant) and returns
whatever the most recent 30-minute optimization cycle decided — the
device is responsible for actually applying that via whichever local
interface it has to the heat pump (RS485/Modbus, etc.); the Worker has no
way to push to it directly, since it sits behind the household's own home
network/NAT. Both fields come back `null` if nothing's been computed
yet (the device polling before the household's first cron cycle, or
before `heatpump_control` was ever switched to `"boreas_device"`) — treat
that as "hold current state," not an error.

## Testing before you trust it

Don't wait for the next scheduled cycle. Trigger one manually and check what
it *would* do:

```bash
curl -X POST https://<your-worker-url>/energy/run \
  -H "Authorization: Bearer <ROSE_API_KEY>"
```

This runs this household's heat pump cycle immediately — including
actually setting the heat pump — and returns the full plan plus which slot
was applied and why. `409` if this household has no heat pump config set
yet; `402` if it does but isn't the `default` household and doesn't have
an active heating add-on subscription (see [`billing.md`](billing.md)).

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

`solar`/`evCharging` are only ever non-null when the calling household is
`default` — they're still single-tenant (see the note at the top of this
page), so `/energy/run` only actually runs that part for `default`,
regardless of who calls it.

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

- **Standalone Boreas devices are Worker-side API only — no hardware or
  firmware exists yet.** `heatpump_control: "boreas_device"` and
  `POST /device/checkin` are real and tested, but nothing to actually run
  them on has been built. See [`boreas-device.md`](boreas-device.md). Also
  not decided yet: the actual device↔Worker wire protocol beyond plain
  HTTPS/JSON, check-in frequency, and what happens (today: nothing —
  no alerting) if a device goes offline for an extended period.
- **Cooling mode ranks purely on price — no efficiency curve.** Heating's
  COP curve (`approximateCop`) models a heat pump getting less efficient
  as it gets colder outside; that shape (and the data behind it) doesn't
  carry over to air conditioning, so rather than reuse or invent a wrong
  one, cooling mode skips efficiency weighting entirely for now. A real
  cooling-efficiency model (units generally get less efficient in extreme
  heat) is future work.
- **ROSE doesn't switch a unit between heating and cooling itself.**
  `hvac_mode` only tells the optimizer which direction to push the target
  temperature — a reversible heat pump's own mode switch (or an AC's
  on/off relative to a furnace) is still on the household's own
  thermostat or existing automations. `"auto"` decides *which direction to
  reason in*, not which physical mode the unit is in — if the unit itself
  is still set to heat-only, `"auto"` deciding "cool" won't do anything
  useful. Worth pairing `"auto"` with a unit/HA automation that can
  actually switch physical mode, once one exists.
- **`"auto"` reacts to the current/near-term reading, not a forecast.**
  It doesn't look ahead the way the price schedule does (e.g. pre-empting
  a heatwave starting tomorrow) — each cycle just checks where today's
  reading sits against the two thresholds. Combined with the 30-minute
  cycle and the hysteresis band, this means a mode switch can lag the
  actual weather by up to that cycle length.
- **A manual tariff is only as accurate as what was entered, and never
  updates itself.** Unlike Octopus Agile's live API, nothing checks a
  manually entered rate against reality — if the household changes tariff,
  or the supplier changes their rates, the schedule silently keeps
  optimizing against stale numbers until someone updates it via the
  dashboard. No expiry warning or reminder is built yet.
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
