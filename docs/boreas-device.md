# Boreas device (planned) — a DIN-rail heat pump/AC gateway

**Not built yet.** This document captures the product direction as of
2026-09-04 so the architecture decisions below are recorded before any
firmware exists, not because there's a device to configure today. Nothing
in this repo currently ships hardware.

## Why a device, not just software

Today, [heating optimization](energy.md) requires the household to already
have Home Assistant running and reachable from the internet
([energy.md's Prerequisite 1](energy.md#1-home-assistant-must-be-reachable-from-the-internet))
— by far the biggest setup barrier the product has, and one a lot of
heating-only customers won't clear: someone who wants cheaper heat pump
running costs has no reason to also run a full smart-home hub.

A dedicated, DIN-rail-mounted Boreas device removes that requirement
entirely. It's a small gateway that sits in the consumer unit/comms
cabinet next to the heat pump, wired directly to it, and talks to the
Cloudflare Worker on its own — no Home Assistant, no tunnel, no existing
smart-home setup. Same idea as Homely's own hardware, and the natural next
step for the standalone-heating-only customer this product doesn't
currently serve well (see [Open question 2](#2-heating-only-billing)
below).

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

**Network side** — RJ45 Ethernet as the reliable default (a DIN-rail
enclosure sits in an electrical cabinet, where a wired drop is often
already there or easy to add), plus **Wi-Fi** so an install doesn't stall
on running a network cable to a cabinet that doesn't have one nearby —
that's a real install-friction reducer, not just a nice-to-have, given how
often the comms cabinet and the heat pump's electrical connection aren't
in the same place. Same reasoning as offering both options rather than
picking one.

## Open questions this needs answers to before any firmware work starts

### 1. Does the device replace Home Assistant, or bridge into it?

- **A — Standalone (recommended starting point).** The device talks
  directly to the Cloudflare Worker: reads the heat pump over RS485/Modbus
  (or whatever interface that model needs), pushes state, and applies
  target-temperature commands the Worker sends back. No Home Assistant
  involved at all. This is what actually removes the Prerequisite-1 barrier
  above, and is the more obviously sellable "just the heating optimizer"
  product.
- **B — Bridge only.** The device exposes the heat pump to an *existing*
  Home Assistant instance (e.g. as a local Modbus-over-TCP endpoint HA's
  own Modbus integration points at, or an ESPHome-style device HA
  auto-discovers) — still requires Home Assistant, but removes the manual
  RS485 wiring/YAML-writing burden for households that already run it.
- **Both** is possible in principle (report to the Worker directly *and*
  expose a local HA entity) but is meaningfully more firmware complexity
  for v1 than either alone.

This decides real backend work: (A) means the Worker needs a new
device-auth class (`households.ts` currently has exactly two —
household bearer token and integrator session cookie — a Boreas unit is
neither: it's not a chat client and it's not a person logging into a
dashboard) plus a telemetry-ingestion/command-dispatch API for it to call.
(B) needs closer to nothing on the Worker side — the device would just be
another Home Assistant integration from ROSE's point of view, identical to
how any heat pump looks today.

### 2. Heating-only billing

A standalone device (option A above) only really makes sense alongside
letting a household actually *buy* heating optimization without the base
£10/month ROSE assistant subscription. Right now,
`handlePortalStartSubscription` always includes the base ROSE price as a
mandatory line item — heating is only ever an *addition* to it, never
standalone (see `cloudflare/src/index.ts`, `docs/billing.md`). That
mismatch — "some people just want the heating optimization, not the voice
assistant" — was flagged earlier and never resolved; this hardware
direction is the point it starts actually mattering, since a customer who
buys a Boreas device presumably isn't buying a voice assistant they'd need
Home Assistant for anyway.

### 3. Hardware/BOM — build vs. buy

**Decision: don't design a custom PCB for v1.** Researched what's already
on the market (2026-09-04) rather than assume a custom board was needed,
and there are two real tiers of existing hardware:

- **Pure protocol gateways** — "dumb" bridges with no custom logic, just
  Modbus RTU↔TCP/MQTT forwarding: Waveshare's
  [RS485 to WiFi/ETH module](https://www.waveshare.com/rs485-to-wifi-eth.htm),
  PUSR's [USR-DR404](https://shop.usriot.com/rs485-to-802.11-a/b/g/n-wlan-serial-device-server-usr-dr404.html),
  Valtoris's [VT-WF110](https://valtoris.com/product/rs485-wifi-ethernet-converter-din-rail/).
  These don't run our code — the Worker would need to speak Modbus
  directly and parse the Samsung register map itself, which doesn't give
  Open question 1's standalone architecture, just relocates where the
  Modbus parsing happens.
- **Programmable, CE-certified ESP32 PLCs** — this is the one that
  actually fits: an ESP32(-S3), Ethernet, Wi-Fi, RS485 (MAX485-based),
  DIN-rail enclosure, already CE-marked, and open to writing our own
  firmware (Arduino/ESP-IDF). Two real options:
  [Erqos EQSP32CE](https://erqos.com/product/eqsp32ce/) (new as of mid-2026 —
  ESP32-S3, Ethernet + Wi-Fi + BLE + RS485/RS232 + CAN bus, ~$185/€155
  single-unit with OEM volume pricing) and
  [Industrial Shields' ESP32 PLC](https://www.industrialshields.com/industrial-hardware-solutions-based-on-esp32)
  line (longer track record, open-source hardware, same shape).

**Why buy rather than design a custom board right now:**

- **Certification, not the PCB itself, is the real cost of custom
  hardware.** This device lives in a customer's electrical consumer
  unit — that almost certainly needs CE/UKCA marking, possibly EMC/safety
  testing with a notified body. These boards already carry that
  certification; using one as-is inherits it instead of paying for it
  from scratch before a single unit's sold.
- **It lets the real open question (1 above) get validated in firmware
  first** — standalone-vs-Home-Assistant-bridge is a protocol/software
  risk, not a hardware one, and can be piloted entirely on an off-the-
  shelf board.
- **Custom PCB only pays off at volume**, once the design is proven and
  the goal shifts to beating ~$185/unit at scale — premature before
  Boreas-the-device has sold anything.

Sources: [CNX Software on the EQSP32CE](https://www.cnx-software.com/2026/06/05/erqos-eqsp32ce-an-industrial-iot-esp32-s3-plc-with-ethernet-rs232-rs485-can-bus-din-rail-support/),
[Industrial Shields' ESP32 PLC technical features](https://www.industrialshields.com/technical-features-industrial-esp32-plc).

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
