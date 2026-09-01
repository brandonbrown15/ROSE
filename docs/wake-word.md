# Wake word ("Rose")

A trained "Rose" wake word model ships in this repo — [`custom_components/rose/wake_word_model/rose.tflite`](../custom_components/rose/wake_word_model/rose.tflite)
— ready to use on a Home Assistant Voice Preview Edition or any
ESPHome/`micro_wake_word` satellite. No training needed on your end.

**If you installed ROSE as a Home Assistant OS/Supervised install**, the
integration installs the model automatically on setup/restart — skip to
[Automatic setup](#automatic-setup). Otherwise, see
[Installing it manually](#installing-it-manually).

## Two different things

- **The wake word** — the word a voice satellite listens for locally,
  always-on, before it starts streaming audio to Home Assistant's Assist
  pipeline. Handled entirely by the satellite (Voice Preview Edition, an
  ESPHome device, a Wyoming satellite) running `micro_wake_word`.
- **The conversation agent** — what actually understands and replies to
  what you say *after* the satellite has already woken up and captured
  your sentence. That's `conversation.rose`, already built and working.

These are independent. You can use ROSE as your assistant today with
whatever wake word your satellite already has (e.g. "Hey Jarvis" or
"OK Nabu") — nothing about the wake word blocks or changes how
`conversation.rose` works. Installing "Rose" as the wake word is a
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
obvious pick (official, ESP32-S3, built for exactly this), or a DIY ESPHome
satellite (M5Stack Atom Echo, etc.) if you'd rather build it yourself. Point
that satellite's Assist pipeline output at your Sonos/B&O `media_player`
entity instead of its own speaker — say "Rose" to the small mic puck, the
reply comes out of your actual speakers.

## Automatic setup

On Home Assistant OS/Supervised installs, the ROSE integration does two
things by itself, every time it starts up (`custom_components/rose/wake_word.py`):

1. **Copies the model** into openWakeWord's shared custom-model folder
   (`/share/openwakeword`), so it shows up in the wake-word dropdown
   without you touching any files.
2. **Selects it**, but only when it's unambiguous and safe: if exactly one
   wake-word provider is set up (e.g. the openWakeWord add-on) and an
   Assist pipeline is using ROSE as its conversation agent *with no wake
   word already chosen*, that pipeline gets "Rose" set as its wake word
   automatically. It deliberately never overwrites a wake word you already
   picked, and never guesses between multiple satellites/providers — those
   cases, and anything it couldn't determine, fall back to a Home
   Assistant notification telling you exactly what happened and what (if
   anything) to do manually.

Check **Settings → Notifications** after installing/restarting to see the
outcome. Say "Rose" to test it — if it doesn't trigger reliably, or
triggers on things that aren't "Rose", see
[Known limitations](#known-limitations--if-you-want-a-more-robust-model)
below; `probability_cutoff` in `rose.json` (currently `0.85`) is the first
thing to tune, either in the add-on's model settings or by editing
`custom_components/rose/wake_word_model/rose.json` and restarting.

This only runs on Supervised/HAOS installs — Core/Container installs don't
have a `/share` folder for it to use, and it no-ops there instead (logs a
line, no notification, nothing breaks). See
[Installing it manually](#installing-it-manually) for that case.

## Installing it manually

For Core/Container installs (no `/share` folder), or if you'd rather not
rely on the automatic step:

1. Get the two files onto your Home Assistant instance:
   `custom_components/rose/wake_word_model/rose.tflite` and `rose.json` from
   this repo (already present locally if you installed ROSE via HACS or a
   manual copy — no separate download needed).
2. **If you run the openWakeWord/`micro_wake_word` add-on** (Voice Preview
   Edition and most Wyoming satellites go through it): copy both files into
   the add-on's custom-model folder (via the Samba or File Editor add-on —
   the exact path is shown on the add-on's own configuration page), then
   pick "Rose" from the wake word dropdown for your satellite device under
   **Settings → Devices & services → Voice Assistants** (or the satellite
   device's own settings page).
3. **If you're flashing an ESPHome satellite yourself**, reference
   `rose.tflite` in the device's `micro_wake_word` YAML config as a local
   model file and reflash.
4. Say "Rose" to test it. If it doesn't trigger reliably, or triggers on
   things that aren't "Rose", see [Known limitations](#known-limitations--if-you-want-a-more-robust-model) below —
   `probability_cutoff` in `rose.json` (currently `0.85`) is the first
   thing to tune: lower it if it's missing real "Rose"s, raise it if it's
   firing on other words.

## How this model was actually built

Same real methodology the wider `micro_wake_word` community uses — this
isn't a shortcut, just a smaller-scale run of it:

- **5,000 positive samples** of "Rose" (US + UK pronunciation), synthesized
  via [Piper](https://github.com/rhasspy/piper) text-to-speech — not real
  recordings of anyone's voice.
- **5,600 confusable-negative samples**: phonetically close words/phrases
  ("close", "those", "grows", "rosa", "ross"...) and other assistants'
  wake words ("hey siri", "hey google", "okay nabu"...), so the model
  learns what to *not* trigger on.
- **7,500 generic negative-speech samples**: everyday commands and phrases
  unrelated to "Rose", also via Piper.
- **MIT room-impulse-response reverb augmentation**, plus pitch/EQ/gain/
  noise perturbations, applied to all of the above.
- Trained with [kahrendt/microWakeWord](https://github.com/kahrendt/microWakeWord)
  (the same training framework Home Assistant's own bundled wake words use)
  for 5,000 steps. Final validation: 98.4% accuracy, 97.7% recall, 97.7%
  precision, 0 estimated false positives/hour on the validation set.
  `wake-word/train_rose.py` is the exact script used, kept here for
  reproducibility.

### What's different from Home Assistant's own bundled wake words

Their official recipe (and the [community trainer](https://github.com/alfiedennen/microwakeword-trainer)
this was adapted from) additionally uses **~16GB of pre-computed negative
examples** — real diverse recordings (dinner-party chatter, varied speech,
ambient background noise) specifically chosen to harden against false
triggers in noisy real-world environments — plus roughly 5x more training
steps on a GPU. Building this model in a disk-constrained sandbox meant
substituting Piper-synthesized negatives for that real-recording dataset,
and fewer training steps on CPU.

**What this means in practice:** the validation metrics above are strong,
but validation ran against the *same kind* of synthetic data the model
trained on — not real rooms with real background noise, TVs, other people
talking, etc. Expect it to work well in a quiet room and possibly need
`probability_cutoff` tuned upward if it false-triggers in a noisier one.
It has not been tested against real hardware or a real voice yet — you are
the first real-world test.

## Known limitations / if you want a more robust model

- **Untested against a real microphone/room.** Everything above is
  synthetic. If it under- or over-triggers in practice, that's expected to
  need tuning (`probability_cutoff`) or, for a real quality jump, retraining
  with real recordings mixed in.
- **No real background-noise corpus.** `AddBackgroundNoise` augmentation
  was skipped entirely (no FMA/AudioSet datasets downloaded) — only reverb
  and signal-level perturbations were applied. A model trained with real
  background noise mixed in would likely be more robust in a busy kitchen
  or living room.
- **Fewer training steps than the official recipe** (5,000 vs. ~45,000) —
  chosen to fit a CPU-only budget, not because more wouldn't help.
- **To build a stronger version**: run the full recipe yourself via the
  [community Colab notebook](https://github.com/alfiedennen/microwakeword-trainer)
  (real GPU, ~45 min, the official negative dataset) and it'll drop in as a
  replacement for `custom_components/rose/wake_word_model/rose.tflite` — same
  manifest format. Or open
  an issue/PR here if you'd like to contribute an improved model trained
  against the full dataset.
