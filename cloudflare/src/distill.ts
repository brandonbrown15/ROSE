import type { Env } from "./index";

export interface MemoryDecision {
  remember: boolean;
  memory: string | null;
  /** "person" is only meaningful (and only ever returned) when a speaker is
   * currently identified — see chat.ts, which resolves it back to null
   * otherwise as a safety net. */
  scope: "household" | "person";
}

function buildDistillPrompt(currentPersonName: string | null): string {
  const scopeGuidance = currentPersonName
    ? `This exchange is attributed to: ${currentPersonName}. If the fact is \
specifically about ${currentPersonName} personally (their own preference, \
habit, or something true of them specifically — not the household), set \
"scope" to "person". If it's true regardless of who's asking (a pet, a \
shared schedule, a device setting), set "scope" to "household".`
    : `The speaker isn't currently identified, so always use \
"scope": "household" for anything you decide to remember — there's no one \
to attribute a personal fact to yet.`;

  return `You review a single exchange from a conversation with ROSE, a persistent \
assistant embedded in a home. Decide whether it contains a durable fact \
worth remembering for future conversations: a stated preference, a fact \
about the household or its people/pets/schedule, a standing instruction, or \
a correction to something ROSE got wrong.

Do NOT remember: small talk, one-off questions, a request to control a \
device "right now" with no standing preference behind it, or anything \
trivial or already obvious.

${scopeGuidance}

Respond with ONLY a JSON object of the form:
{"remember": boolean, "memory": string | null, "scope": "household" | "person"}

If "remember" is true, "memory" must be a single, self-contained sentence \
stating the fact in third person (e.g. "The office thermostat should stay \
at 68°F in winter." or "Sarah takes her coffee black."), written so it \
makes sense on its own without the original conversation. If "remember" is \
false, "memory" and "scope" are ignored.`;
}

/**
 * Ask the model whether a just-completed exchange contains something worth
 * remembering long-term, and if so, produce a short, storable summary of it
 * and whether it's a household-wide or person-specific fact. Never throws —
 * a distillation failure just means nothing gets remembered.
 */
export async function distillMemory(
  env: Env,
  userText: string,
  reply: string,
  currentPersonName: string | null
): Promise<MemoryDecision> {
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
          { role: "system", content: buildDistillPrompt(currentPersonName) },
          { role: "user", content: `USER: ${userText}\nASSISTANT: ${reply}` },
        ],
      }),
    });

    if (!res.ok) {
      return { remember: false, memory: null, scope: "household" };
    }

    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    const parsed = JSON.parse(data.choices[0].message.content) as Partial<MemoryDecision>;

    if (parsed.remember === true && typeof parsed.memory === "string" && parsed.memory.trim()) {
      // Never trust "person" scope from the model if we don't actually have
      // a currently-identified speaker to attribute it to.
      const scope = parsed.scope === "person" && currentPersonName ? "person" : "household";
      return { remember: true, memory: parsed.memory.trim(), scope };
    }
  } catch {
    // Malformed JSON, network error, etc. — treat as "nothing to remember"
    // rather than failing the request.
  }

  return { remember: false, memory: null, scope: "household" };
}
