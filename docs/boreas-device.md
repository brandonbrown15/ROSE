# Boreas device (planned) — a standalone heat pump/AC gateway

**Not built yet.** This document captures the product direction as of
2026-09-05 so the architecture decisions below are recorded before any
firmware exists, not because there's a device to configure today. Nothing
in this repo currently ships hardware.

## Why a device, not just software

Today, [Boreas Heating and Cooling Optimisation](energy.md) requires the household to already
have Home Assistant running and reachable from the internet
([energy.md's Prerequisite 1](energy.md#1-home-assistant-must-be-reachable-from-the-internet))
— by far the biggest setup barrier the product has, and one a lot of
heating-only customers won't clear: someone who wants cheaper heat pump
running costs has no reason to also run a full smart-home hub.

A dedicated Boreas device removes that requirement entirely. It's a small
gateway that sits near the heat pump, wired directly to it, and talks to
the Cloudflare Worker on its own — no Home Assistant, no tunnel, no
existing smart-home setup. Same idea as Homely's own hardware, and the
natural next step for the standalone-heating-only customer this product
doesn't currently serve well (see [Open question 2](#2-heating-only-billing)
below).

**Not DIN-rail mounted.** DIN-rail was the original assumption, but it
pulled hardware selection toward industrial-grade, certified PLC boards
priced for trade/commercial buyers (~$150-200/unit — see
[Open question 3](#3-hardwarebom--build-vs-buy)), which doesn't work for a
consumer product. A simple wall-mounted or free-standing enclosure instead
opens up ordinary maker-grade hardware at a tenth of that cost.

## Connectivity

**Heat-pump side** — depends on the unit, so this needs to be
interchangeable rather than one fixed interface:

- **RS485 (Modbus RTU)** as the primary, best-supported path. Samsung's
  own **MIM-B19N** gateway module bridges its proprietary NASA (R1/R2) bus
  to standard Modbus RTU over RS485 (see [energy.md's heat pump entity
  section](energy.md#5-your-heat-pumps-entity-id-and-a-room-temperature-sensor)
  for the specifics already researched) — a Boreas device with an RS485
  port and a Modbus client can read/write it directly, no Home Assistant
  Modbus integration in between. Likely the same story for other
  manufacturers that expose a BMS/Modbus interface.
- **Other manufacturer-specific interfaces** as the need arises — some heat
  pumps (Daikin, Mitsubishi Ecodan) are more commonly integrated via the
  manufacturer's own cloud API than a local bus, in which case the device
  wouldn't need a physical interface for that unit at all; the Worker would
  talk to the manufacturer's cloud the way `energy.ts` already reasons
  about doing for anything without a local bus. Worth tracking which
  interface each supported model actually needs as real installs happen,
  rather than guessing a full list now.

**Network side** — **Wi-Fi**, primarily: this is a consumer unit, not
industrial kit sitting in a comms cabinet next to an existing wired drop,
and requiring an Ethernet run is exactly the kind of install friction that
made avoiding a Home Assistant/tunnel prerequisite worth doing in the
first place. Wired Ethernet stays a possible option for a later variant if
some installs need it, but isn't the v1 default the way it would be for a
DIN-rail industrial gateway.

## Open questions

### 1. Does the device replace Home Assistant, or bridge into it? — RESOLVED: standalone

Brandon's call (2026-09-04): **standalone.** The device talks directly to
the Cloudflare Worker — reads the heat pump over RS485/Modbus (or whatever
interface that model needs), and applies target-temperature commands the
Worker computes. No Home Assistant involved at all. This is what actually
removes the Prerequisite-1 barrier above, and is the more obviously
sellable "just Boreas" product. (The alternative
considered — bridging into an existing Home Assistant instance — is not
being built; noted here only so the reasoning isn't lost.)

**Built now, ahead of any hardware existing**, so the Worker side is ready
whenever firmware starts:

- Migration `0012_boreas_devices.sql`: `households` gains
  `heatpump_control` (`'home_assistant'` default, or `'boreas_device'`);
  new `boreas_devices` table (one per household for v1, matching the
  existing single-zone limitation) holding a device's own bearer
  credential (`device_key` — genuinely separate from the household's own
  `api_key`, so a compromised physical device can't be used to authenticate
  as the household's chat/HA client) plus its last-reported room
  temperature and the pending command for it to pick up.
- **Why polling, not push**: a Boreas unit sits behind the household's own
  home network/NAT — the Worker can never dial into it directly, unlike a
  household's Home-Assistant instance (which the household has to make
  publicly reachable, e.g. via Cloudflare Tunnel — Prerequisite 1). So
  control flips direction: the device calls the Worker periodically
  instead.
- `cloudflare/src/devices.ts`: `provisionBoreasDevice`/`resolveBoreasDevice`
  (device identity/auth) and `recordDeviceCheckin`/`getDeviceRoomTempC`/
  `setPendingDeviceCommand` (the check-in round trip).
- `POST /integrator/households/:id/device` — same session-authed, ownership-
  checked pattern as the HA/energy endpoints, provisions (or rotates) a
  device's credential. Shown once, same as a household's own `api_key`.
- `POST /device/checkin` — the device's own bearer auth (its `device_key`,
  not the household's `api_key`): `{ "room_temp_c": 19.4 }` in, and back
  comes `{ "target_temp_c": 21, "hvac_mode": "heat" }` — whatever the most
  recent 30-minute optimization cycle decided. Nulls back mean nothing's
  been computed yet (device polling before the household's first cycle, or
  before `heatpump_control` was ever switched to `'boreas_device'`) — same
  "missing config = no-op, not a guess" principle as the rest of
  `energy.ts`.
- `energy.ts`'s `runHeatPumpOptimization` branches on `heatpumpControl`:
  `'boreas_device'` reads the room temperature from the device's last
  check-in instead of a Home Assistant sensor, and writes the computed
  target as that household's pending command instead of calling
  `climate.set_temperature` — everything else (the price/weather ranking,
  the safety floor/ceiling override) is identical either way.
- Dashboard gets a **Boreas device** panel per household (provision/rotate
  the credential) and the heating-config form gets a **Control method**
  dropdown that hides the Home-Assistant-only entity-ID fields when set to
  standalone.

Verified: full migration chain (0001–0012) locally, zero FK violations;
the check-in round trip (provision → write a pending command → check in
with a room reading → read the command back → confirm the reading was
stored) directly against sqlite's `UPDATE ... RETURNING`, which is what
`recordDeviceCheckin` relies on.

**Still not decided — genuinely needs hardware/firmware to answer**: the
actual wire protocol between the physical device and the Worker (this
assumes plain HTTPS + JSON, matching everything else this Worker already
does — MQTT would be the industrial-IoT-conventional alternative, but adds
a broker and doesn't obviously buy anything here), check-in frequency, and
what happens if a device goes offline for an extended period (right now:
nothing — `pending_target_temp_c` just goes stale until the next cron
cycle overwrites it, no alerting yet).

### 2. Heating-only billing

A standalone device (option A above) only really makes sense alongside
letting a household actually *buy* Boreas without the base £10/month ROSE
assistant subscription. Right now, `handlePortalStartSubscription` always
includes the base ROSE price as a mandatory line item — Boreas is only
ever an *addition* to it, never standalone (see `cloudflare/src/index.ts`,
`docs/billing.md`). That mismatch — "some people just want Boreas, not the
voice assistant" — was flagged earlier and never resolved; this hardware
direction is the point it starts actually mattering, since a customer who
buys a Boreas device presumably isn't buying a voice assistant they'd need
Home Assistant for anyway.

### 3. Hardware/BOM — build vs. buy

**Decision: don't design a custom PCB for v1, and don't use an industrial
DIN-rail PLC either — plain maker-grade modules instead.** Researched what's
on the market in two passes:

**First pass (2026-09-04, DIN-rail assumed)** landed on CE-certified ESP32
PLCs — [Erqos EQSP32CE](https://erqos.com/product/eqsp32ce/) or
[Industrial Shields' ESP32 PLC](https://www.industrialshields.com/industrial-hardware-solutions-based-on-esp32)
line, ~$150-200/unit. Once DIN-rail was dropped (2026-09-05 — see
[Connectivity](#connectivity) above), that price point stopped making
sense for a consumer product, so:

**Revised: a plain ESP32 dev board + a small RS485 add-on, in an ordinary
plastic enclosure — roughly $10-20/unit in components:**

- **ESP32 dev board** — a basic WROOM devkit (~$3-8) for Wi-Fi-only, or the
  [WT32-ETH01](https://www.espboards.dev/esp32/wt32-eth01/) (ESP32 +
  built-in Ethernet PHY + Wi-Fi + Bluetooth, **$9-18 retail, ~$2-3 at
  AliExpress/volume** — [JacobsParts](https://www.jacobsparts.com/items/DEVBOARD-G))
  if a wired-Ethernet variant is ever wanted.
- **RS485 transceiver** — a MAX485 TTL-to-RS485 breakout module, ~$1-3.
- **Enclosure** — an off-the-shelf plastic project box (~$2-5), not a
  certified DIN-rail housing.

**v1 recommendation: Wi-Fi-only** (plain devkit + MAX485, skip Ethernet
entirely) — Wi-Fi was already the priority for install ease, and Ethernet
was only pulling its weight when this was also an industrial, wired-by-
default device. A wired variant (WT32-ETH01) stays available later if
real installs need it.

**Certification correction — doesn't carry over from the first pass.** The
CE-certified-PLC option's certification argument was specific to that
option: the board itself was already CE-marked, so using it as-is inherited
that. A bare ESP32 dev board's radio (Wi-Fi/Bluetooth) is separately
pre-certified — Espressif's modules carry their own FCC/CE RED
certification — but **the finished, assembled Boreas unit still needs its
own CE/UKCA marking** as a product wired into a heat pump's electrics,
regardless of which board sits inside it. That compliance/testing cost
doesn't disappear by choosing cheaper hardware — it needs budgeting for
before real units ship, same as it always would have for a custom PCB,
just smaller in scope than designing the electronics from scratch too.

Sources: [espboards.dev's WT32-ETH01 spec page](https://www.espboards.dev/esp32/wt32-eth01/),
[JacobsParts WT32-ETH01 listing](https://www.jacobsparts.com/items/DEVBOARD-G).

### 4. Device provisioning

Whatever a household's identity is today (household `api_key`, generated
once, shown once — see [households.md](households.md)), a physical device
needs an equivalent: how does a Boreas unit prove which household it
belongs to the first time it powers on? A factory-programmed device
identity claimed via a code/QR during setup (closest to how most
consumer IoT hardware does it) is the likely shape, but this is downstream
of (1) and not decided.

## What this doc is not

Not a commitment to a ship date, a bill of materials, or a firmware
language/framework — those follow once [Open question 1](#1-does-the-device-replace-home-assistant-or-bridge-into-it)
is answered. This exists so the reasoning behind "standalone device,
RS485 + Ethernet + Wi-Fi" is written down rather than only in chat history.
