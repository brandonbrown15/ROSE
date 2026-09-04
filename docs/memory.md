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

That question also includes sincerity, not just topic: an obvious joke,
piece of roleplay, or made-up exaggeration ("I'm secretly a dragon," a kid
saying they never have to go to bed) gets discarded the same as small talk,
even though it's phrased just as confidently as a real preference. A
household includes kids and playful adults, and distillation runs with no
memory of tone or context beyond the one exchange it's looking at, so this
is necessarily a judgment call, not a fact-check — there's no way to verify
whether a stated preference is *true*, only whether it reads as sincere.
When genuinely unsure, it errs toward not storing: a real fact missed once
just gets mentioned again in a later conversation; a fictional one stored
as real doesn't correct itself.

If the model decides yes:

1. The distilled sentence is stored in D1's `memories` table.
2. Its embedding is stored in Vectorize, using the memory's `id` as the
   vector id.

This runs in the background after the reply is already sent (via
`ctx.waitUntil`), so it never adds latency to the conversation.

### Deduplication

`distill.ts` decides fresh on every exchange whether something's worth
remembering — it has no memory of what's already been stored, so the same
fact mentioned again in a different conversation (a coffee preference
brought up three separate times, say) would otherwise just pile up as
repeat rows with nothing to show for it. Before actually storing, `chat.ts`
(`storeIfNew`) checks whether a near-duplicate already exists in the same
scope (same household, same person-or-household-wide attribution) via
[`dedupe.ts`](../cloudflare/src/dedupe.ts) — the same embedding computed
for the new memory, checked against Vectorize for a close match above a
similarity threshold (0.93 cosine similarity currently). A match means the
new one is silently dropped, not stored.

This isn't just about storage size (which is trivial at any realistic
scale) — it's about recall quality. `recall()` only returns a handful of
memories per reply; three identical copies of the same fact waste slots
that could've surfaced something else actually relevant to the question,
without adding any information a single copy didn't already have.

Still fully manual today: a duplicate that already exists from *before*
this existed doesn't get cleaned up automatically, and the threshold is a
fixed constant, not tunable per-deployment. `DELETE FROM memories` (plus
the matching `MEMORY_INDEX.deleteByIds`) is still the way to remove one
by hand.

### Supersession — updates, not overwrites

A near-duplicate (above) is the *same* fact said again. This is different:
the *same real-world thing* changing value — a job, an address, a stated
preference that's since changed. "I now work at Globex" shouldn't erase
"I used to work at Acme" — that's still true, just not current — but ROSE
also shouldn't keep treating the old employer as the current one.

After a memory clears the duplicate check, `storeIfNew` (`chat.ts`) looks
for existing memories in the same scope that are semantically close enough
to be worth checking (a lower bar than the duplicate threshold — related,
not necessarily near-identical) via
[`supersede.ts`](../cloudflare/src/supersede.ts). If there are any
candidates, one more model call asks specifically: does the new fact
*update* one of these, as opposed to merely being on a similar topic (two
facts that can both stay true at once — "likes coffee" and "likes tea" —
are not an update, even if topically close)? If it identifies one, that
memory is marked `superseded_by` the new one's id — never deleted, just
excluded from what `recall()` and `dedupe.ts` treat as current.

The result: the old memory is still sitting in D1 forever (nothing about
"I don't want it to forget" is violated), and a normal "where do you work"
question only ever surfaces the current answer as current — but a
superseded memory isn't hidden from recall altogether. `recall()` ranks
purely by relevance to the question asked, current or not, and returns a
`current: boolean` flag on every result; `chat.ts` labels the non-current
ones (`[no longer current — history]`) when building RELEVANT MEMORIES, and
the persona prompt tells the model to treat a labeled memory as past, not
present, while still drawing on it when the question genuinely wants both
("help me apply for this job" pulls in current *and* prior experience —
"where did I used to work?" surfaces the old employer, correctly framed as
history). Superseded facts only ever show up when they're actually one of
the closest semantic matches to the question — the same relevance bar as
any other memory, nothing special about being retired.

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

ROSE's personality and behavior guidance lives in `ROSE_PERSONA_INTRO`/
`ROSE_PERSONA_OUTRO` in [`chat.ts`](../cloudflare/src/chat.ts) — plain
strings, edited and deployed like any other code, not something managed
from the OpenAI dashboard (ROSE calls the Chat Completions API with an
inline prompt, not a hosted Prompt object). `buildSystemPrompt()` appends
the person/memory guidance described above per-request; the persona text
itself doesn't need to know anything about memory scoping.

The device-control paragraph in between those two is the one exception —
it's one of two mutually exclusive strings (`DEVICE_CONTROL_GUIDANCE` /
`NO_DEVICE_CONTROL_GUIDANCE`), chosen by `buildSystemPrompt()` based on
whether Home Assistant is actually configured (`HA_URL`/`HA_TOKEN` set),
the same check that decides whether `control_device` is offered as a tool
at all. This matters more than it might look: prose describing what the
model *should* do with a tool isn't the same as the tool actually being
available, and a system prompt that unconditionally describes a PIN-gated
unlock flow will get roleplayed confidently even with zero real capability
behind it — asking for a PIN, then fabricating a "rejected" response, with
no real tool call anywhere in the loop. Reproduced live, not theoretical.

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
- New memories are deduplicated against existing ones, and checked for
  whether they update (supersede) an existing one, before storing (see
  [Deduplication](#deduplication) and [Supersession](#supersession--updates-not-overwrites)
  above). There's still no way to explicitly ask ROSE to forget something —
  `DELETE FROM memories` (and the matching `MEMORY_INDEX.deleteByIds`) is
  the manual way to actually remove one today; a "forget that" management
  endpoint is a natural next step.
- Recall currently always runs on every request. A future version could skip
  it for obviously-stateless requests to save an embedding call.
