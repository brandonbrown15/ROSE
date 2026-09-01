# Wake word ("Hey Rose")

Short answer: **yes, possible** — but it needs a custom-trained model, and
it's a separate piece from everything else in this repo.

## Two different things

- **The wake word** — the word a voice satellite listens for locally,
  always-on, before it starts streaming audio to Home Assistant's Assist
  pipeline. Handled entirely by the satellite (an ESPHome device, a Wyoming
  satellite, Home Assistant's Voice Preview Edition hardware, etc.) running
  a wake-word engine — usually openWakeWord or ESPHome's `micro_wake_word`.
- **The conversation agent** — what actually understands and replies to
  what you say *after* the satellite has already woken up and captured
  your sentence. That's `conversation.rose`, already built and working.

These are independent. You can use ROSE as your assistant today with
whatever wake word your satellite already has (e.g. "Hey Jarvis" or
"OK Nabu") — nothing about the wake word blocks or changes how
`conversation.rose` works. Getting the wake word itself to be "Rose" is a
one-time, additional step on top, not a prerequisite.

## Choosing satellite hardware — and why Sonos/B&O can't be it

Neither Sonos nor B&O can be the **listening** device. Both are closed
ecosystems — neither exposes its microphone array or on-device audio
pipeline to third-party software, so there's no way to run a custom
wake-word engine on one. Sonos Voice Control and B&O's Alexa/Google-built-in
options are locked to their own (or licensed) voice stacks; you can't swap
in "Rose" as the wake word on that hardware.

They're still genuinely useful for the *other* half, though — Assist
treats "what's listening" and "what talks back" as separate things you can
mix freely:

- **Sonos** — HA's official core integration already lets ROSE's reply
  play through it (`media_player`/TTS announce, multi-room grouping) today,
  no wake word involved.
- **B&O** — a community integration covers the newer "Mozart platform"
  speakers (Beosound Balance, Beolab 8, etc.) for the same kind of
  playback control.

So: keep Sonos/B&O as ROSE's *voice* (they already sound better than any
purpose-built satellite's tiny speaker), and add a small, cheap microphone
device per room for the *listening* half — Home Assistant's own
[Voice Preview Edition](https://www.home-assistant.io/voice-pe/) is the
obvious pick (official, ESP32-S3, built for exactly this, works with a
custom-trained wake word out of the box), or a DIY ESPHome satellite
(M5Stack Atom Echo, etc.) if you'd rather build it yourself. Point that
satellite's Assist pipeline output at your Sonos/B&O `media_player` entity
instead of its own speaker — say "Rose" to the small mic puck, the reply
comes out of your actual speakers.

## Getting a custom "Rose" wake word

"Rose" isn't one of the handful of wake words Home Assistant ships by
default, so it needs training. Two paths:

### Option A — openWakeWord (recommended)

Free, open source, and Home Assistant's actively-maintained default —
matches ROSE's whole approach so far (no subscriptions needed beyond the
OpenAI/Cloudflare costs you already have).

1. **Train a model.** The [openWakeWord project](https://github.com/dscripka/openWakeWord)
   provides a training notebook that synthesizes training audio for your
   chosen word via text-to-speech + augmentation — you don't need to record
   yourself saying it hundreds of times. Type "rose", run it (free Colab
   GPU, roughly 20–40 minutes), and it outputs a small `.tflite`/`.onnx`
   model file.
2. **Install the model.**
   - **openWakeWord add-on** (if your satellite runs through it — Voice
     Preview Edition, an ATOM Echo, or a software/Wyoming satellite): copy
     the model file into the add-on's custom-model folder (via Samba, SSH,
     or the File Editor add-on), then select it for your satellite/Assist
     pipeline under **Settings → Voice assistants**.
   - **ESPHome-based satellite** (M5Stack, a custom ESP32-S3-BOX, etc.):
     the `micro_wake_word` component takes a custom model reference in its
     YAML config; re-flash the device with it included.

### Option B — Picovoice Porcupine

[console.picovoice.ai](https://console.picovoice.ai) generates a custom
wake-word model (`.ppn`) instantly — no training wait — for a typed word,
with a free tier for personal use. Higher out-of-the-box accuracy than a
quick openWakeWord model, but proprietary, and Home Assistant's own tooling
has shifted toward openWakeWord as the default path in recent releases, so
check current HA docs for how well Porcupine integrates before committing
to this route — that's shifted enough recently that I don't want to
overstate today's exact support here.

**Recommendation: openWakeWord.** Free, open, and the path Home Assistant
itself is investing in.

## Once you have the model

Nothing in `custom_components/rose` needs to change. The wake word plugs
into whichever Assist pipeline you already point at `conversation.rose`
(**Settings → Voice assistants**) — it's satellite/pipeline configuration,
not something this repo's code touches.

## Not something to add to this repo

The trained model itself is a personal artifact (tuned to your voice and
accent), not shared infrastructure — it doesn't belong committed here the
way the Worker or the HA integration does. This page is the guide; the
actual training happens once you have satellite hardware in hand. Come back
and ask if you hit friction on the exact YAML/add-on config once you're at
that step — happy to help debug against real hardware.
