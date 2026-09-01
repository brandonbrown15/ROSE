# Installation

This is an end-to-end setup: deploy the Worker first, then add the Home
Assistant integration.

## 0. Prerequisites

- A Cloudflare account (Workers, D1, and Vectorize are all available on the
  free plan at low volumes).
- An OpenAI API key.
- A Home Assistant instance you can install custom integrations on.
- Node.js 18+ and the [`wrangler`](https://developers.cloudflare.com/workers/wrangler/)
  CLI (installed automatically by `scripts/setup.sh` as a dev dependency).

## 1. Clone and configure

```bash
git clone https://github.com/brandonbrown15/rose.git
cd rose
cp .env.example .env
# edit .env and fill in OPENAI_API_KEY / ROSE_API_KEY (generate one:
# openssl rand -hex 32)
./scripts/setup.sh
```

`setup.sh` installs the Worker's npm dependencies and walks you through
creating the D1 database and Vectorize index (see
[`cloudflare.md`](cloudflare.md) if you'd rather do it by hand).

## 2. Deploy the Worker

```bash
./scripts/deploy.sh
```

This pushes your secrets to Cloudflare (`wrangler secret put`) and deploys
the Worker (`wrangler deploy`). Note the `*.workers.dev` URL it prints, or
your custom domain if you've mapped one — you'll need it in step 3.

Alternatively, push to `main` and let the `deploy` GitHub Actions workflow
do it — see [`cloudflare.md`](cloudflare.md#github-actions-deploys).

## 3. Install the Home Assistant integration

**Manually:**

```bash
cp -r home-assistant/custom_components/rose \
  <config>/custom_components/rose
```

then restart Home Assistant.

**Via HACS:** add this repository as a custom repository (category:
Integration) and install **ROSE — Persistent AI Assistant**. See
[`home-assistant.md`](home-assistant.md).

## 4. Add the integration

**Settings → Devices & services → Add Integration → ROSE**, then enter:

- **ROSE URL**: your Worker's URL from step 2
- **API Key**: the `ROSE_API_KEY` value from your `.env`

Home Assistant will call the Worker's `/health` endpoint to verify the
connection before saving. On success, `conversation.rose` becomes available
as a conversation agent.

## 5. Try it

**Developer Tools → Actions**, call `conversation.process`:

```yaml
agent_id: conversation.rose
text: "Remember that the office thermostat should stay at 68 in winter."
```

Then in a new conversation, ask "what temperature should the office
thermostat be in winter?" — see [`memory.md`](memory.md) for how recall
works.
