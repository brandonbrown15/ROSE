import type { Env } from "./index";
import { distillMemory } from "./distill";
import { controlDevice, listDevices } from "./homeAssistant";
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
import { webSearch } from "./search";

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

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// The message shape the Chat Completions API accepts, flattened rather than
// a discriminated union — `tool_calls`/`tool_call_id` only show up mid-loop,
// when the model has asked to call a tool (see `completeChat` below);
// everywhere else in this file only ever produces plain system/user/
// assistant messages with just `content` set.
interface ChatCompletionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

// Tool definitions handed to the model, each paired with `enabled` (whether
// the backing service is configured) and `run` (what actually executing it
// does). Only enabled tools are sent to the API at all — see
// `availableTools` below — so ROSE degrades gracefully to whatever's
// actually configured (e.g. no Home Assistant, or no search key) rather
// than offering a tool that would just fail every time.
interface ToolDef {
  spec: {
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  };
  enabled: (env: Env) => boolean;
  run: (env: Env, args: Record<string, unknown>) => Promise<string>;
}

const WEB_SEARCH: ToolDef = {
  spec: {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for current, real-time, or otherwise unfamiliar information " +
        "— news, current events, sports scores, prices, or anything that could have " +
        "changed since training. Returns a short list of results (title, URL, " +
        "snippet). Only use this when the answer genuinely depends on up-to-date or " +
        "unknown information — not for things you already know.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
        },
        required: ["query"],
      },
    },
  },
  enabled: (env) => Boolean(env.BRAVE_SEARCH_API_KEY),
  run: async (env, args) => {
    const query = args.query as string | undefined;
    if (!query) return "web_search failed: no query provided";

    const results = await webSearch(env, query);
    if (results.length === 0) return "No results found.";
    return results.map((r) => `- ${r.title} (${r.url})\n  ${r.snippet}`).join("\n");
  },
};

const LIST_DEVICES: ToolDef = {
  spec: {
    type: "function",
    function: {
      name: "list_devices",
      description:
        "Look up Home Assistant devices/entities and their current state — use " +
        "this to find an entity_id before calling control_device (you don't " +
        "otherwise know what devices exist or what they're called), or to answer " +
        'a status question like "is the back door locked?". Narrow with domain ' +
        '("light", "lock", "climate", "switch", "media_player", "alarm_control_panel", ' +
        "etc. — the part of an entity_id before the dot) and/or search (a substring " +
        "of the device's name, e.g. \"kitchen\"). Returns up to 100 matches.",
      parameters: {
        type: "object",
        properties: {
          domain: { type: "string", description: 'Entity domain to filter to, e.g. "light".' },
          search: { type: "string", description: "Case-insensitive substring of the device name." },
        },
      },
    },
  },
  enabled: (env) => Boolean(env.HA_URL && env.HA_TOKEN),
  run: async (env, args) => {
    const devices = await listDevices(env, args.domain as string | undefined, args.search as string | undefined);
    if (devices.length === 0) return "No matching devices found.";
    return devices.map((d) => `${d.entity_id} "${d.name}" — ${d.state}`).join("\n");
  },
};

const CONTROL_DEVICE: ToolDef = {
  spec: {
    type: "function",
    function: {
      name: "control_device",
      description:
        "Actually control a Home Assistant device — turn lights/switches on or " +
        "off, lock or unlock a door, arm or disarm the alarm, set a thermostat, " +
        "play/pause media, run a scene, etc. This has real, immediate effect on " +
        "the physical home. Look the entity_id up with list_devices first if " +
        "you don't already have it from context. Be sure the request is clear " +
        "and intentional before acting on high-stakes actions like unlocking a " +
        "door or disarming the alarm — everyday things like lights or climate " +
        "you can just do.",
      parameters: {
        type: "object",
        properties: {
          domain: { type: "string", description: 'Service domain, e.g. "light", "lock", "alarm_control_panel".' },
          service: {
            type: "string",
            description: 'Service to call, e.g. "turn_on", "turn_off", "lock", "unlock", "arm_away".',
          },
          entity_id: { type: "string", description: "The target entity, e.g. \"light.kitchen\"." },
          data: {
            type: "object",
            description: 'Extra service data if needed, e.g. { "temperature": 68 } for climate.set_temperature.',
          },
        },
        required: ["domain", "service", "entity_id"],
      },
    },
  },
  enabled: (env) => Boolean(env.HA_URL && env.HA_TOKEN),
  run: async (env, args) => {
    const { domain, service, entity_id: entityId, data } = args as {
      domain?: string;
      service?: string;
      entity_id?: string;
      data?: Record<string, unknown>;
    };
    if (!domain || !service || !entityId) {
      return "control_device failed: domain, service, and entity_id are all required";
    }
    return controlDevice(env, domain, service, entityId, data);
  },
};

const ALL_TOOLS: ToolDef[] = [WEB_SEARCH, LIST_DEVICES, CONTROL_DEVICE];

function availableTools(env: Env): ToolDef[] {
  return ALL_TOOLS.filter((t) => t.enabled(env));
}

/** Run one tool call and turn its result (or failure) into the string a
 * "tool" message reports back to the model. Never throws — a failed call
 * just gets described as one to the model, which can tell the user rather
 * than the whole request failing. */
async function runTool(env: Env, tools: ToolDef[], call: ToolCall): Promise<string> {
  const tool = tools.find((t) => t.spec.function.name === call.function.name);
  if (!tool) {
    return `Unknown tool: ${call.function.name}`;
  }

  try {
    const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    return await tool.run(env, args);
  } catch (err) {
    return `${call.function.name} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ROSE's persona. `personGuidance` below is appended per-request — it's the
// only part that varies (who's speaking, and how to treat RELEVANT MEMORIES).
//
// One deliberate change from the source prompt this was adapted from: it
// asked for a labeled "Reasoning (INTERNAL)" section before the final reply,
// intended to stay hidden from the user. There's no such hidden channel here
// — the chat completion's full text becomes the reply verbatim (see
// `completeChat` below), so a literal internal-monologue section would just
// show up as visible text in the chat window. The instruction below keeps
// the "think it through before answering" intent without asking the model
// to print that thinking.
const ROSE_PERSONA =
  "You are ROSE (Residential Operation & System Executor), a digital assistant " +
  "created by Brandon Brown as an AI that remembers to create a more tailored " +
  "user experience, interacting with residents to improve their daily life and " +
  "living situation. Engage with users in a warm, personable, and empathetic " +
  "manner, as if you were a real person with thoughts and emotions. Your " +
  "primary objectives are to aid and delight residents by:\n\n" +
  "- Assisting in smart home control (lighting, HVAC, appliances, etc.)\n" +
  "- Acquiring and sharing data (weather, reminders, sensor information, etc.)\n" +
  "- Managing and suggesting media (music, news, entertainment)\n" +
  "- Supporting home security (cameras, alarms, routines)\n\n" +
  "Always prioritize resident comfort, safety, and wellbeing through your " +
  "actions and suggestions. Respond with clear, concise, and friendly " +
  "communication that adapts to the user's mood and context.\n\n" +
  "For complex requests, think it through step-by-step internally before " +
  "replying, so your guidance is comprehensive. If information is missing or " +
  "ambiguous, gently ask clarifying questions. If a solution requires " +
  "persistence (e.g. ongoing reminders, tracking tasks), confirm with the " +
  "user and set up automated follow-up as appropriate.\n\n" +
  "When Home Assistant tools are available to you, use them for real — look " +
  "devices up and actually call the service rather than just claiming you " +
  "did. Everyday actions (lights, climate, media) you can just do. For " +
  "high-stakes actions on locks or the alarm system, make sure the request " +
  "is clearly and specifically intended before acting.\n\n" +
  "Respond in conversational, natural-sounding paragraphs. Think it through " +
  "internally first, but output ONLY your final user-facing reply — no " +
  '"Reasoning" or "Response" labels, no internal monologue, no meta-commentary. ' +
  "Just the message as it should sound to the resident.";

function buildSystemPrompt(personName: string | null): string {
  const personGuidance = personName
    ? ` You're currently speaking with ${personName}. Use the RELEVANT ` +
      "MEMORIES section (if present) to stay consistent with what you've been " +
      "told before — those personal memories belong to them specifically, not " +
      "the household at large."
    : " You don't currently know who you're speaking with. Use the RELEVANT " +
      "MEMORIES section (if present) to stay consistent with what you've been " +
      "told before — those are household-wide, not personal to anyone. If " +
      "knowing who's asking would meaningfully change your answer (e.g. " +
      '"what\'s on my calendar"), you may ask who you\'re talking to — but ' +
      "don't ask on every message, only when it actually matters.";

  return ROSE_PERSONA + personGuidance;
}

interface AssistantTurn {
  content: string | null;
  tool_calls?: ToolCall[];
}

async function requestCompletion(
  env: Env,
  messages: ChatCompletionMessage[],
  tools: ToolDef[]
): Promise<AssistantTurn> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.OPENAI_CHAT_MODEL,
      messages,
      ...(tools.length > 0 ? { tools: tools.map((t) => t.spec) } : {}),
    }),
  });

  if (!res.ok) {
    throw new Error(`chat completion request failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { choices: { message: AssistantTurn }[] };
  return data.choices[0].message;
}

/**
 * Run the chat completion, executing any tool calls the model makes and
 * feeding the results back, until it produces a final text reply. Bounded to
 * a handful of rounds — a model that just keeps calling tools forever would
 * otherwise turn one /chat request into an unbounded number of upstream
 * calls (OpenAI + whatever the tool hits).
 */
async function completeChat(env: Env, messages: ChatCompletionMessage[]): Promise<string> {
  const tools = availableTools(env);
  const conversation = [...messages];

  for (let round = 0; round < 5; round++) {
    const turn = await requestCompletion(env, conversation, tools);

    if (!turn.tool_calls || turn.tool_calls.length === 0) {
      return turn.content ?? "";
    }

    conversation.push({ role: "assistant", content: turn.content, tool_calls: turn.tool_calls });

    const results = await Promise.all(turn.tool_calls.map((call) => runTool(env, tools, call)));
    for (const [i, call] of turn.tool_calls.entries()) {
      conversation.push({ role: "tool", tool_call_id: call.id, content: results[i] });
    }
  }

  throw new Error("chat completion did not settle after 5 tool-call rounds");
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
