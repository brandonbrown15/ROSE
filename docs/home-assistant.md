# Home Assistant Integration

Source lives in [`custom_components/rose`](../custom_components/rose).

## What it adds

- A **config flow** (Settings → Devices & services → Add Integration → ROSE)
  that asks for your Worker URL and API key and validates the connection.
- A **conversation agent** entity, `conversation.rose`, usable anywhere Home
  Assistant accepts a conversation agent: the Assist chat UI, voice
  satellites, and automations/scripts via `conversation.process`.

## Installing

### Via HACS (recommended — one click)

1. HACS → Integrations → ⋮ → Custom repositories → add
   `https://github.com/brandonbrown15/rose`, category **Integration**.
2. Search for **ROSE — Persistent AI Assistant** and install it.
3. Restart Home Assistant.

`hacs.json` at the repository root declares the integration, and
`custom_components/rose` sits at the repo root — HACS's standard layout for
an integration — so this works out of the box, no manual file copying.

### Manually

If you'd rather not use HACS, copy `custom_components/rose` into your Home
Assistant config's `custom_components/` directory, then restart:

```bash
cp -r custom_components/rose <config>/custom_components/rose
```

## Configuring

**Settings → Devices & services → Add Integration → ROSE**:

| Field | Value |
|---|---|
| ROSE URL | Your deployed Worker, e.g. `https://rose.example.workers.dev` |
| API Key | The `ROSE_API_KEY` you set as a Worker secret |

Home Assistant calls `GET /health` on the Worker to confirm the connection
before saving. `cannot_connect` means the URL is wrong or the Worker isn't
deployed; `invalid_auth` means the API key doesn't match.

## Using it

Set `conversation.rose` as the conversation agent for a voice assistant
pipeline (**Settings → Voice assistants**), or call it directly:

```yaml
service: conversation.process
data:
  agent_id: conversation.rose
  text: "turn the memory of today's plans into a note for tomorrow"
```

ROSE decides on its own whether anything in an exchange is worth
remembering long-term — see [`memory.md`](memory.md). You don't need to
tell it to remember something; just say it.

See [`../home-assistant/examples/talk_to_rose_automation.yaml`](../home-assistant/examples/talk_to_rose_automation.yaml)
for a full automation, and [`../home-assistant/blueprints/`](../home-assistant/blueprints/)
for reusable blueprints as they're added.

## Troubleshooting

- **Integration doesn't appear after copying the files** — restart Home
  Assistant fully; custom components are only discovered at startup.
- **`cannot_connect` in the config flow** — check the Worker URL is reachable
  from your Home Assistant instance and that `wrangler deploy` succeeded.
- **Replies are slow** — the first request to a cold Worker, plus an OpenAI
  round trip, can take a couple of seconds; subsequent requests are faster.
