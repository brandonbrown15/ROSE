import type { Env } from "./index";
import { distillMemory } from "./distill";
import { identifySpeaker } from "./identify";
import {
  getConversationPersonId,
  getRecentMessages,
  recordMessage,
  setConversationPerson,
  storeMemory,
} from "./memory";
import { findOrCreatePerson, listPeople, type Person } from "./people";
import { recall } from "./recall";

interface ChatRequestBody {
  conversation_id?: string;
  text: string;
  /**
   * Controls long-term memory for this exchange:
   *  - omitted (default): ROSE decides for itself whether this exchange
   *    contains a durable fact worth remembering, and stores a distilled
   *    summary if so. This is what you want almost always.
   *  - true: force storage even if ROSE wouldn't otherwise remember it.
   *  - false: never store this exchange, regardless of content.
   */
  remember?: boolean;
}

interface ChatCompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function buildSystemPrompt(personName: string | null): string {
  const base =
    "You are ROSE, a persistent, helpful assistant embedded in a Home Assistant " +
    "installation. Use the RELEVANT MEMORIES section (if present) to stay " +
    "consistent with what you've been told before. Keep replies concise — " +
    "they may be read aloud.";

  const personGuidance = personName
    ? ` You're currently speaking with ${personName}. Personal memories in ` +
      "RELEVANT MEMORIES belong to them specifically, not the household at large."
    : " You don't currently know who you're speaking with — memories in " +
      "RELEVANT MEMORIES (if any) are household-wide, not personal to anyone. " +
      "If knowing who's asking would meaningfully change your answer (e.g. " +
      '"what\'s on my calendar"), you may ask who you\'re talking to — but ' +
      "don't ask on every message, only when it actually matters.";

  return base + personGuidance;
}

async function completeChat(env: Env, messages: ChatCompletionMessage[]): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: env.OPENAI_CHAT_MODEL, messages }),
  });

  if (!res.ok) {
    throw new Error(`chat completion request failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  return data.choices[0].message.content;
}

export async function handleChat(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  let body: ChatRequestBody;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (!body.text || typeof body.text !== "string") {
    return new Response(JSON.stringify({ error: "'text' is required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const conversationId = body.conversation_id ?? crypto.randomUUID();

  const [history, people, existingPersonId] = await Promise.all([
    getRecentMessages(env, conversationId),
    listPeople(env),
    getConversationPersonId(env, conversationId),
  ]);

  const existingPerson = people.find((p) => p.id === existingPersonId) ?? null;

  // Does *this* message identify (or hand off to) a speaker? Runs before
  // recall so a message that both introduces someone and asks something
  // personal ("this is Sarah, what's on my calendar?") gets that person's
  // memories on the very same turn, not starting next turn.
  const identified = await identifySpeaker(env, body.text, people, existingPerson?.name ?? null);
  let resolvedPerson: Person | null = existingPerson;
  if (identified.name) {
    resolvedPerson = await findOrCreatePerson(env, identified.name);
  }

  const memories = await recall(env, body.text, resolvedPerson?.id ?? null);

  const messages: ChatCompletionMessage[] = [
    { role: "system", content: buildSystemPrompt(resolvedPerson?.name ?? null) },
  ];

  if (memories.length > 0) {
    const memoryBlock = memories.map((m) => `- ${m.content}`).join("\n");
    messages.push({ role: "system", content: `RELEVANT MEMORIES:\n${memoryBlock}` });
  }

  messages.push(...history, { role: "user", content: body.text });

  const reply = await completeChat(env, messages);

  // Persist the exchange for short-term context on the next turn, and
  // decide whether it's worth remembering long-term. All of this runs after
  // the response is composed so it never adds latency to the reply.
  ctx.waitUntil(
    (async () => {
      await recordMessage(env, conversationId, "user", body.text);
      await recordMessage(env, conversationId, "assistant", reply);

      if (resolvedPerson && resolvedPerson.id !== existingPersonId) {
        await setConversationPerson(env, conversationId, resolvedPerson.id);
      }

      if (body.remember === false) {
        return; // caller explicitly opted this exchange out
      }

      const decision = await distillMemory(env, body.text, reply, resolvedPerson?.name ?? null);
      if (decision.remember && decision.memory) {
        const personId = decision.scope === "person" ? resolvedPerson?.id ?? null : null;
        await storeMemory(env, decision.memory, conversationId, personId);
      } else if (body.remember === true) {
        // Caller forced storage but nothing distilled cleanly — fall back
        // to the raw exchange rather than silently dropping it. Household-
        // wide, since we don't know it's specifically personal.
        await storeMemory(env, `User said: "${body.text}" — ROSE replied: "${reply}"`, conversationId, null);
      }
    })()
  );

  return new Response(
    JSON.stringify({
      conversation_id: conversationId,
      reply,
      memories_used: memories.length,
      person: resolvedPerson?.name ?? null,
    }),
    { headers: { "content-type": "application/json" } }
  );
}
