import type { Env } from "./index";

export interface MemoryDecision {
  remember: boolean;
  memory: string | null;
}

const DISTILL_PROMPT = `You review a single exchange from a conversation with ROSE, a persistent \
assistant embedded in a home. Decide whether it contains a durable fact \
worth remembering for future conversations: a stated preference, a fact \
about the household or its people/pets/schedule, a standing instruction, or \
a correction to something ROSE got wrong.

Do NOT remember: small talk, one-off questions, a request to control a \
device "right now" with no standing preference behind it, or anything \
trivial or already obvious.

Respond with ONLY a JSON object of the form:
{"remember": boolean, "memory": string | null}

If "remember" is true, "memory" must be a single, self-contained sentence \
stating the fact in third person (e.g. "The office thermostat should stay \
at 68°F in winter."), written so it makes sense on its own without the \
original conversation. If "remember" is false, "memory" must be null.`;

/**
 * Ask the model whether a just-completed exchange contains something worth
 * remembering long-term, and if so, produce a short, storable summary of it.
 * Never throws — a distillation failure just means nothing gets remembered.
 */
export async function distillMemory(env: Env, userText: string, reply: string): Promise<MemoryDecision> {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.OPENAI_CHAT_MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: DISTILL_PROMPT },
          { role: "user", content: `USER: ${userText}\nASSISTANT: ${reply}` },
        ],
      }),
    });

    if (!res.ok) {
      return { remember: false, memory: null };
    }

    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    const parsed = JSON.parse(data.choices[0].message.content) as Partial<MemoryDecision>;

    if (parsed.remember === true && typeof parsed.memory === "string" && parsed.memory.trim()) {
      return { remember: true, memory: parsed.memory.trim() };
    }
  } catch {
    // Malformed JSON, network error, etc. — treat as "nothing to remember"
    // rather than failing the request.
  }

  return { remember: false, memory: null };
}
