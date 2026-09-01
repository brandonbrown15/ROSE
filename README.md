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

```bash
git clone https://github.com/brandonbrown15/rose.git
cd rose
./scripts/setup.sh
```

That's the whole backend setup. One script takes you from a fresh clone to a
deployed Worker: it installs dependencies, logs you into Cloudflare, creates
the D1 database and Vectorize index, generates a `ROSE_API_KEY` for you,
asks for your OpenAI key (the one secret nobody but you can supply), and
deploys. It prints your Worker URL and API key at the end — those two values
are all you need to install the [Home Assistant integration](docs/home-assistant.md).

See [`docs/installation.md`](docs/installation.md) for the full walkthrough.

## Secrets

Nothing sensitive lives in this repository. `.env.example` documents the
variables ROSE needs; the real values live in:

- **Cloudflare Worker secrets** (set automatically by `scripts/setup.sh` via
  `wrangler secret put`)
- **Home Assistant** (entered via the integration's config flow, stored in HA's
  own encrypted config entry storage)
- **GitHub Actions secrets**, if you wire up automatic deploys

That's what makes it safe for this repository to be public.

## Installing the Home Assistant integration via HACS

`custom_components/rose` sits at the repo root, HACS's standard layout for
an integration, so installation is one click: add this repository to HACS as
a custom repository (category: Integration), install
**ROSE — Persistent AI Assistant**, restart Home Assistant, then configure it
from **Settings → Devices & services → Add Integration → ROSE**, supplying
the Worker URL and API key `scripts/setup.sh` printed. See
[`docs/home-assistant.md`](docs/home-assistant.md).

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — how the pieces fit together
- [`docs/installation.md`](docs/installation.md) — end-to-end setup
- [`docs/cloudflare.md`](docs/cloudflare.md) — Worker, D1, and Vectorize details
- [`docs/home-assistant.md`](docs/home-assistant.md) — the HA integration
- [`docs/memory.md`](docs/memory.md) — how ROSE decides what to remember

## License

[MIT](LICENSE)
