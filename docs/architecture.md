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
  entity state or call services while composing a reply.

Storage:

- **D1** (`migrations/0001_initial.sql`) — `conversations`, `messages`,
  `memories`.
- **Vectorize** — one vector per memory, keyed by `memories.id`.

```
Home Assistant  ──HTTP (Bearer ROSE_API_KEY)──▶  Cloudflare Worker
                                                    │        │
                                                    ▼        ▼
                                                   D1     Vectorize
                                                    │
                                                    ▼
                                                 OpenAI
```

## 2. ROSE Home Assistant (`home-assistant/`)

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
