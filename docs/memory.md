# Memory

ROSE keeps two distinct kinds of memory. Everything here is additionally
scoped to *which* household is asking — see [`households.md`](households.md)
for that layer; this doc otherwise talks about "household-wide" the way it
always has, meaning "not attributed to one specific person" within
whichever household the request belongs to.

## Short-term: conversation history

Every message in a conversation is written to D1's `messages` table, keyed by
`conversation_id` (see [`migrations/0001_initial.sql`](../cloudflare/migrations/0001_initial.sql)).
On each turn, `chat.ts` pulls the most recent messages for that
`conversation_id` and includes them as chat context — this is what lets a
single back-and-forth stay coherent, the same as any chatbot's context
window.

This resets per conversation: a brand new `conversation_id` (e.g. a fresh
voice assistant session) starts with no history.

## Long-term: durable memories

This is automatic — you don't need to tell ROSE to remember something, you
just say it. After every reply, `distill.ts` sends the exchange (what the
user said, what ROSE replied) back to the model with one question: *is there
a durable fact here worth remembering?* Small talk, one-off questions, and
"turn the lights off now" get discarded. A stated preference, a household
fact, a standing instruction, or a correction gets kept — as a short,
self-contained sentence, not the raw exchange.

If the model decides yes:

1. The distilled sentence is stored in D1's `memories` table.
2. Its embedding is stored in Vectorize, using the memory's `id` as the
   vector id.

This runs in the background after the reply is already sent (via
`ctx.waitUntil`), so it never adds latency to the conversation.

### Overriding it

The `/chat` request body's `remember` field lets a caller override the
automatic decision for one exchange:

| `remember` | Behavior |
|---|---|
| omitted (default) | ROSE decides for itself, as described above |
| `true` | Force storage even if ROSE wouldn't otherwise remember it (falls back to storing the raw exchange if distillation still declines) |
| `false` | Never store this exchange, no matter what it contains |

The Home Assistant integration leaves this at the default — it never sends
`remember` unless something explicitly calls `async_chat(..., remember=True)`
or `remember=False` — so normal conversations get the automatic behavior.

## Personalization: who's talking

ROSE can attribute memories to a specific household member instead of the
household at large — "Sarah takes her coffee black" vs. "the office
thermostat should stay at 68°F" — so recall stays relevant to whoever's
actually asking.

**Identity here is entirely self-reported.** ROSE only ever sees
already-transcribed text from Home Assistant's voice pipeline, never raw
audio, so there's no voice biometrics involved — someone has to actually
say who they are (e.g. "this is Sarah, what's on my calendar?"). This is a
real, deliberate limitation, not a placeholder for something smarter
happening silently — see [Future: real voice identification](#future-real-voice-identification-phase-2)
below for what a from-audio version would actually require.

On every `/chat` request, `identify.ts` asks the model one narrow question:
does *this specific message* state who's speaking (a self-introduction, or a
handoff to a different known person)? If so, `people.ts` resolves that name
to a household member (creating one if this is the first time they've come
up), and the conversation stays attributed to them — via
`conversations.person_id` — until someone else identifies themselves in the
same conversation. If a message doesn't say, nothing changes: the
conversation keeps whatever attribution (or lack of one) it already had.

That attribution then feeds two things on the same turn:

- **Recall** (`recall.ts`) filters out memories that belong to a *different*
  specific person — household-wide memories (no `person_id`) always come
  through regardless.
- **Distillation** (`distill.ts`) additionally decides *scope* — is this new
  fact about the currently-identified person specifically, or true
  regardless of who's asking — and stores it with the matching `person_id`
  (or `NULL` for household-wide).

When nobody's identified, everything behaves exactly as before: recall and
storage both operate household-wide only, and the system prompt tells the
model it may ask who it's talking to, but only when that would actually
change the answer — not on every message.

### Future: real voice identification (phase 2)

The above requires someone to say who they are; it can't recognize a voice
on its own. Doing that for real would mean inserting a new stage *before*
Home Assistant's speech-to-text step — since by the time text reaches
`conversation.rose`, the audio is already gone — to extract a voice
embedding from the incoming audio and match it against enrolled voiceprints
per person. That's meaningfully new infrastructure (an enrollment flow, a
speaker-embedding model, and a way to get the result into ROSE's context
before or alongside transcription), not an extension of what's described
here. Worth doing if self-identification turns out to be too much friction
in practice — not before.

## Recall

On every `/chat` request, `recall.ts` embeds the incoming text and queries
Vectorize for the closest stored memories. The matching memory text is
resolved back out of D1 and injected into the system prompt as
`RELEVANT MEMORIES`, so the model can use it without it having been part of
this conversation's own history. The D1 lookup also filters to the
requesting household's own rows — see
[`households.md`](households.md#what-this-deliberately-doesnt-do-yet) for
why that filter happens in D1 rather than in the Vectorize query itself.

```
new message
    │
    ├──▶ embed(text) ──▶ Vectorize.query() ──▶ wide candidate pool of ids
    │                                              │
    │                                              ▼
    │                                    D1: SELECT content
    │                                    FROM memories WHERE household_id = ?
    │                                    AND id IN (...) — take top-K of these
    │                                              │
    ▼                                              ▼
short-term history  +  RELEVANT MEMORIES  ──▶  chat completion
                                                    │
                                                    ▼
                                          reply sent to caller
                                                    │
                                     (background, after the reply)
                                                    ▼
                                     distill.ts: worth remembering?
                                          yes ──▶ storeMemory()
```

## Persona / system prompt

ROSE's personality and behavior guidance lives in `ROSE_PERSONA` in
[`chat.ts`](../cloudflare/src/chat.ts) — a plain string, edited and deployed
like any other code, not something managed from the OpenAI dashboard (ROSE
calls the Chat Completions API with an inline prompt, not a hosted Prompt
object). `buildSystemPrompt()` appends the person/memory guidance described
above onto it per-request; the persona text itself doesn't need to know
anything about memory scoping.

One thing intentionally left out: don't ask the model for a separate hidden
"reasoning" section before its reply. There's no hidden channel in a plain
chat completion — the whole response text becomes the reply verbatim (see
`completeChat` in `chat.ts`), so a literal "Reasoning (internal): ... /
Response: ..." structure would just show up as visible text in the chat
window instead of staying hidden. "Think it through, then answer" is fine;
asking it to print that thinking is not.

## Design notes / future work

- **Identification runs on the request's critical path, unlike
  distillation.** `distill.ts` runs in the background after the reply is
  already sent, so it never adds latency or blocks on failure. `identify.ts`
  can't do that — the whole point is letting a single message both identify
  someone *and* get a personalized answer on that same turn — so it's one
  more OpenAI round-trip before every reply. In practice this is comparable
  cost to the embedding call recall already made on every request; still,
  it's a real, deliberate latency/cost tradeoff, not a free addition.
- Distillation and recall both use `OPENAI_CHAT_MODEL` today; a separate,
  cheaper model for distillation (it's a small classification/summarization
  task, not a conversational reply) would cut cost without hurting quality —
  a natural next step if usage grows.
- Memories are never automatically forgotten, deduplicated, or updated. A
  `DELETE FROM memories` (and the matching `MEMORY_INDEX.deleteByIds`) is the
  manual way to remove one today; a "forget that" management endpoint/service
  call is a natural next step.
- Recall currently always runs on every request. A future version could skip
  it for obviously-stateless requests to save an embedding call.
