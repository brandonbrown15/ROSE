import type { Env } from "./index";
import { getRecentMessages, recordMessage, storeMemory } from "./memory";
import { recall } from "./recall";

interface ChatRequestBody {
  conversation_id?: string;
  text: string;
  /** Set true to also distill and store this exchange as a durable memory. */
  remember?: boolean;
}

interface ChatCompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const SYSTEM_PROMPT =
  "You are ROSE, a persistent, helpful assistant embedded in a Home Assistant " +
  "installation. Use the RELEVANT MEMORIES section (if present) to stay " +
  "consistent with what you've been told before. Keep replies concise — " +
  "they may be read aloud.";

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

  const [history, memories] = await Promise.all([
    getRecentMessages(env, conversationId),
    recall(env, body.text),
  ]);

  const messages: ChatCompletionMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];

  if (memories.length > 0) {
    const memoryBlock = memories.map((m) => `- ${m.content}`).join("\n");
    messages.push({ role: "system", content: `RELEVANT MEMORIES:\n${memoryBlock}` });
  }

  messages.push(...history, { role: "user", content: body.text });

  const reply = await completeChat(env, messages);

  // Persist the exchange for short-term context on the next turn, and
  // optionally distill it into long-term memory. Both run after the
  // response is composed so they never add latency to the reply.
  ctx.waitUntil(
    (async () => {
      await recordMessage(env, conversationId, "user", body.text);
      await recordMessage(env, conversationId, "assistant", reply);
      if (body.remember) {
        await storeMemory(env, `User said: "${body.text}" — ROSE replied: "${reply}"`, conversationId);
      }
    })()
  );

  return new Response(
    JSON.stringify({ conversation_id: conversationId, reply, memories_used: memories.length }),
    { headers: { "content-type": "application/json" } }
  );
}
