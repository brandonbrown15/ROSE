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

### 3. Hardware/BOM

Not decided, and not urgent until (1) is answered — but worth naming the
obvious, well-trodden shape for this kind of device so it's clear it's a
known-solvable embedded problem, not speculative: a Wi-Fi-and-Bluetooth
SoC (e.g. an ESP32) paired with a MAX485-style RS485 transceiver and,
if Ethernet is wanted on the same board rather than Wi-Fi-only, a small
Ethernet PHY (e.g. W5500) — a standard combination for DIN-rail Modbus
gateways generally. This needs real component/cost decisions once (1) is
settled, not before.

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
