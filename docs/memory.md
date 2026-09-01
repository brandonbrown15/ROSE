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

Long-term memory is opt-in per request via `"remember": true` in the `/chat`
body. When set, the exchange is distilled into a short text summary and:

1. The text is stored in D1's `memories` table.
2. Its embedding is stored in Vectorize, using the memory's `id` as the
   vector id.

This is what lets ROSE recall something told to it in a *previous*, unrelated
conversation.

## Recall

On every `/chat` request — regardless of `remember` — `recall.ts` embeds the
incoming text and queries Vectorize for the closest stored memories. The
matching memory text is resolved back out of D1 and injected into the system
prompt as `RELEVANT MEMORIES`, so the model can use it without it having been
part of this conversation's own history.

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
```

## Design notes / future work

- Recall currently always runs; a future version could skip it for
  obviously-stateless requests to save an embedding call.
- Memories are never automatically forgotten or deduplicated. A `DELETE FROM
  memories` (and the matching `MEMORY_INDEX.deleteByIds`) is the manual way
  to remove one today; a management endpoint/service call is a natural next
  step.
- `remember` currently stores the whole exchange verbatim rather than an
  LLM-distilled summary — good enough as a starting point, but summarizing
  before storage would keep memories shorter and more useful at recall time.
