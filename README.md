# ROSE

**R**esidential **O**peration & **S**ystem **E**xecutor

ROSE is a persistent, memory-backed AI assistant for Home Assistant. It pairs a
lightweight Cloudflare Worker backend (chat completion + long-term memory) with
a Home Assistant custom integration that registers ROSE as a
`conversation.rose` conversation agent. It figures out on its own what's
worth remembering — you just talk to it.

```
GitHub
   │
   ├── Cloudflare Worker   (chat, memory, recall — cloudflare/)
   ├── D1 schema           (conversations, messages, memories)
   ├── Vectorize           (semantic recall over past memories)
   ├── Home Assistant integration (custom_components/rose/)
   ├── HA automations/examples
   └── Documentation       (docs/)
```

## Components

| Component | Path | Description |
|---|---|---|
| **ROSE Core** | [`cloudflare/`](cloudflare) | Cloudflare Worker backend: chat, D1-backed memory, Vectorize-backed recall, automatic memory distillation |
| **ROSE Home Assistant** | [`custom_components/rose/`](custom_components/rose) | HA integration: conversation agent, config flow, services — installable via HACS |
| **Docs** | [`docs/`](docs) | Architecture, installation, and component guides |

## Quick start

**1. Deploy the backend** — one script, needs only Node.js and a Cloudflare
account:

```bash
git clone https://github.com/brandonbrown15/rose.git
cd rose
./scripts/setup.sh
```

It installs dependencies, logs you into Cloudflare, creates the D1 database
and Vectorize index, generates a `ROSE_API_KEY` for you, asks once for your
OpenAI key (the one secret nobody but you can supply), and deploys. It
prints your Worker URL and API key at the end.

**2. Install the Home Assistant integration** — two clicks, on your own HA
instance:

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=brandonbrown15&repository=ROSE&category=integration)
[![Open your Home Assistant instance and start setting up a new integration.](https://my.home-assistant.io/badges/config_flow_start.svg)](https://my.home-assistant.io/redirect/config_flow_start/?domain=rose)

First badge → **Download** → restart Home Assistant. Second badge → paste in
the Worker URL and API key from step 1. Done — `conversation.rose` is live,
and it decides on its own what's worth remembering.

See [`docs/installation.md`](docs/installation.md) for the full walkthrough,
or [`docs/home-assistant.md`](docs/home-assistant.md) if either badge
doesn't work for your setup.

## Secrets

Nothing sensitive lives in this repository. `.env.example` documents the
variables ROSE needs; the real values live in:

- **Cloudflare Worker secrets** (set automatically by `scripts/setup.sh` via
  `wrangler secret put`)
- **Home Assistant** (entered via the integration's config flow, stored in HA's
  own encrypted config entry storage)
- **GitHub Actions secrets**, if you wire up automatic deploys

That's what makes it safe for this repository to be public.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — how the pieces fit together
- [`docs/installation.md`](docs/installation.md) — end-to-end setup
- [`docs/cloudflare.md`](docs/cloudflare.md) — Worker, D1, and Vectorize details
- [`docs/home-assistant.md`](docs/home-assistant.md) — the HA integration
- [`docs/memory.md`](docs/memory.md) — how ROSE decides what to remember
- [`docs/wake-word.md`](docs/wake-word.md) — getting a custom "Rose" wake word for voice satellites

## License

[MIT](LICENSE)
