# ROSE

**R**esidential **O**peration & **S**ystem **E**xecutor

ROSE is a persistent, memory-backed AI assistant for Home Assistant. It pairs a
lightweight Cloudflare Worker backend (chat completion + long-term memory) with
a Home Assistant custom integration that registers ROSE as a
`conversation.rose` conversation agent.

```
GitHub
   │
   ├── Cloudflare Worker   (chat, memory, recall — cloudflare/)
   ├── D1 schema           (conversations, messages, memories)
   ├── Vectorize           (semantic recall over past memories)
   ├── Home Assistant integration (home-assistant/)
   ├── HA automations/examples
   └── Documentation       (docs/)
```

## Components

| Component | Path | Description |
|---|---|---|
| **ROSE Core** | [`cloudflare/`](cloudflare) | Cloudflare Worker backend: chat, D1-backed memory, Vectorize-backed recall |
| **ROSE Home Assistant** | [`home-assistant/`](home-assistant) | HA `custom_component`: conversation agent, config flow, services |
| **Docs** | [`docs/`](docs) | Architecture, installation, and component guides |

## Quick start

```bash
git clone https://github.com/brandonbrown15/rose.git
cd rose
./scripts/setup.sh
```

`setup.sh` copies `.env.example` to `.env`, installs the Worker's dependencies,
and walks you through creating the D1 database and Vectorize index. You still
need to supply your own secrets (OpenAI key, ROSE API key, Home Assistant
token) — see [`docs/installation.md`](docs/installation.md).

## Secrets

Nothing sensitive lives in this repository. `.env.example` documents the
variables ROSE needs; the real values live in:

- **Cloudflare Worker secrets** (`wrangler secret put ...`)
- **Home Assistant** (entered via the integration's config flow, stored in HA's
  own encrypted config entry storage)
- **GitHub Actions secrets**, if you wire up automatic deploys

That's what makes it safe for this repository to be public.

## Installing the Home Assistant integration via HACS

Add this repository to HACS as a custom repository (category: Integration),
then install **ROSE — Persistent AI Assistant** and configure it from
**Settings → Devices & services → Add Integration → ROSE**, supplying your
Worker URL and API key. See [`docs/home-assistant.md`](docs/home-assistant.md).

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — how the pieces fit together
- [`docs/installation.md`](docs/installation.md) — end-to-end setup
- [`docs/cloudflare.md`](docs/cloudflare.md) — Worker, D1, and Vectorize details
- [`docs/home-assistant.md`](docs/home-assistant.md) — the HA integration
- [`docs/memory.md`](docs/memory.md) — how ROSE remembers things

## License

[MIT](LICENSE)
