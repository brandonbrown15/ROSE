# Memory

ROSE keeps two distinct kinds of memory.

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

## Recall

On every `/chat` request, `recall.ts` embeds the incoming text and queries
Vectorize for the closest stored memories. The matching memory text is
resolved back out of D1 and injected into the system prompt as
`RELEVANT MEMORIES`, so the model can use it without it having been part of
this conversation's own history.

```
new message
    │
    ├──▶ embed(text) ──▶ Vectorize.query() ──▶ top-K memory ids
    │                                              │
    │                                              ▼
    │                                    D1: SELECT content
    │                                    FROM memories WHERE id IN (...)
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

## Design notes / future work

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
