# Architecture

ROSE has three logical components. Today this repository ships the first two;
the third is a placeholder for future work.

## 1. ROSE Core (`cloudflare/`)

A Cloudflare Worker that is the actual "brain":

- **`src/index.ts`** — HTTP entry point. Authenticates requests with a bearer
  `ROSE_API_KEY` and routes them (`/chat`, `/health`).
- **`src/chat.ts`** — composes a reply: pulls recent conversation history and
  semantically recalled memories, sends them to OpenAI's chat completions
  API, then hands the exchange to `distill.ts` for a long-term-memory
  decision in the background.
- **`src/distill.ts`** — asks the model whether an exchange contains a fact
  worth remembering and, if so, produces a short summary of it. This is what
  makes memory automatic rather than something a caller has to flag.
- **`src/memory.ts`** — reads/writes conversation and message rows in D1, and
  writes long-term memories (distilled text in D1, embedding in Vectorize).
- **`src/recall.ts`** — embeds a query and searches Vectorize for the closest
  stored memories, resolving the matching text back out of D1.
- **`src/ha.ts`** — an optional callback path so ROSE can read Home Assistant
  entity state or call services while composing a reply — also what the
  energy optimizer below uses to read room temperature and control the heat
  pump.
- **`src/energy.ts`**, **`src/octopus.ts`**, **`src/metoffice.ts`**,
  **`src/solaredge.ts`** — optional, off by default, and each piece
  (heat pump / solar / EV) independently gated on its own config: a
  deterministic (not LLM-driven) optimizer that ranks Octopus Agile price
  slots by efficiency-adjusted cost using a Met Office forecast, layers in
  a live SolarEdge surplus reading (free heat beats cheap heat), and drives
  the heat pump and (solar-surplus-first) EV charging via Home Assistant
  services through `ha.ts`. EV control deliberately goes through HA rather
  than a direct SolarEdge call — SolarEdge doesn't publish an official API
  for it. Runs on a Cloudflare Cron Trigger (`wrangler.jsonc` →
  `triggers.crons`), not on the request path. See [`energy.md`](energy.md).

Storage:

- **D1** (`migrations/0001_initial.sql`, `0002_energy.sql`,
  `0003_energy_events.sql`) — `conversations`, `messages`, `memories`,
  `energy_plans`, `energy_events`.
- **Vectorize** — one vector per memory, keyed by `memories.id`.

```
Home Assistant  ──HTTP (Bearer ROSE_API_KEY)──▶  Cloudflare Worker
                                                    │        │
                                                    ▼        ▼
                                                   D1     Vectorize
                                                    │
                                                    ▼
                                                 OpenAI

Cloudflare Cron (every 30 min, optional)  ──▶  energy.ts
                                                  │    │    │
                                          Octopus │    │Met │ SolarEdge
                                                  ▼    ▼Office▼
                                          heat pump + EV plan ──▶ Home Assistant
                                          (climate.set_temperature,
                                           charger start/stop service)
```

## 2. ROSE Home Assistant (`custom_components/rose/`)

A `custom_components/rose` integration that:

- Presents a **config flow** asking for the Worker URL and API key, and
  validates the connection against `/health` before saving.
- Registers a **conversation agent** (`conversation.rose`) so ROSE can be
  used anywhere Home Assistant accepts a conversation agent — voice
  assistants, the Assist chat, scripts, and automations via
  `conversation.process`.

See [`home-assistant.md`](home-assistant.md).

## 3. ROSE SDK/API (future)

Not yet part of this repository. The idea: thin Python/JS/REST clients around
the same `/chat` API the Home Assistant integration uses, so other projects
(e.g. a separate assistant front-end) can talk to the same ROSE backend and
share its memory.

## Deployment

`.github/workflows/deploy.yml` deploys the Worker with `wrangler deploy` on
every push to `main`, using repository secrets
(`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) — see
[`cloudflare.md`](cloudflare.md).
