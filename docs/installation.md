# Installation

## 0. Prerequisites

- A Cloudflare account (Workers, D1, and Vectorize are all available on the
  free plan at low volumes).
- An OpenAI API key ([platform.openai.com/api-keys](https://platform.openai.com/api-keys)) — the one secret
  nothing in this repo can generate for you.
- A Home Assistant instance you can install custom integrations on
  (HACS, if you want one-click installs — see step 3).
- Node.js 18+. `wrangler` itself is installed automatically as a dev
  dependency.

## 1. Clone and run the setup script

```bash
git clone https://github.com/brandonbrown15/rose.git
cd rose
./scripts/setup.sh
```

This single script takes you from a fresh clone to a deployed Worker:

1. Installs the Worker's npm dependencies.
2. Runs `wrangler login` if you aren't already authenticated with Cloudflare.
3. Creates the D1 database (`rose-db`) and patches `cloudflare/wrangler.jsonc`
   with its id automatically — no manual copy-pasting.
4. Creates the Vectorize index (`rose-memory`).
5. Applies the D1 schema migration.
6. Prompts for your **OpenAI API key** (once, hidden input) and saves it to
   `.env`.
7. **Generates a `ROSE_API_KEY` for you** — this is the shared secret between
   the Worker and Home Assistant; you don't need to invent, remember, or run
   anything yourself to get one.
8. Pushes both as Worker secrets (`wrangler secret put`) and runs
   `wrangler deploy`.

At the end it prints your Worker's URL and the generated `ROSE_API_KEY` —
save those, you'll need them in step 3. Re-running `./scripts/setup.sh`
later is safe; it skips anything already set up and just redeploys.

If you'd rather do any of this by hand (e.g. you already have a D1 database
you want to reuse), see [`cloudflare.md`](cloudflare.md) for the manual
steps `setup.sh` automates. For a later code change, use
`./scripts/deploy.sh` instead of rerunning full setup, or just push to
`main` and let the `deploy` GitHub Actions workflow handle it — see
[`cloudflare.md`](cloudflare.md#github-actions-deploys).

## 2. Install the Home Assistant integration

Click, then **Download**, then restart Home Assistant:

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=brandonbrown15&repository=ROSE&category=integration)

(Doesn't work, or don't use HACS? See the manual-install fallback in
[`home-assistant.md`](home-assistant.md#installing).)

## 3. Add the integration

[![Open your Home Assistant instance and start setting up a new integration.](https://my.home-assistant.io/badges/config_flow_start.svg)](https://my.home-assistant.io/redirect/config_flow_start/?domain=rose)

Enter the two values `setup.sh` printed:

- **ROSE URL**: your Worker's `*.workers.dev` URL
- **API Key**: the generated `ROSE_API_KEY`

Home Assistant calls the Worker's `/health` endpoint to verify the
connection before saving. On success, `conversation.rose` becomes available
as a conversation agent.

## 4. Try it

**Developer Tools → Actions**, call `conversation.process`:

```yaml
agent_id: conversation.rose
text: "The office thermostat should stay at 68 in winter."
```

Then in a *new* conversation, ask "what temperature should the office
thermostat be in winter?" ROSE decided on its own that the first message was
worth remembering — you never had to say "remember this." See
[`memory.md`](memory.md) for how that decision and recall work.
