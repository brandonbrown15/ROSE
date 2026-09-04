import type { Env } from "./index";
import type { Person } from "./people";

export interface IdentifyResult {
  /** The display name of who's speaking, if THIS message says so — not who
   * it's about. Null means no new identification signal in this message
   * (which is not the same as "unidentified" — the caller keeps whatever
   * the conversation was already attributed to). */
  name: string | null;
}

function buildPrompt(knownPeople: Person[], currentPersonName: string | null): string {
  const known =
    knownPeople.length > 0
      ? `Household members ROSE already knows: ${knownPeople.map((p) => p.name).join(", ")}.`
      : "ROSE doesn't know any household members' names yet.";

  const current = currentPersonName
    ? `This conversation is currently attributed to: ${currentPersonName}.`
    : "This conversation isn't currently attributed to anyone.";

  return `You read a single message sent to ROSE, a home assistant, and decide \
whether it explicitly states WHO is speaking right now — not who the \
message is *about*.

${known}
${current}

Return a name ONLY when THIS message plainly identifies the speaker (e.g. \
"this is Sarah", "it's Bob here", "hey Rose, it's me, Sarah again" — "me" \
resolving via the current attribution above counts). If a different known \
person explicitly identifies themselves, that's a handoff — return their \
name. Do NOT return a name just because someone is mentioned in passing \
(e.g. "tell Sarah dinner's ready" is NOT Sarah speaking).

If this message contains no new identification, return null — even if the \
conversation is already attributed to someone. You're only deciding \
whether *this* message adds new identity information, not reaffirming an \
existing one; the caller keeps the existing attribution on its own when \
you return null. When genuinely unsure, return null rather than guessing.

Respond with ONLY a JSON object: {"name": string | null}`;
}

/**
 * Decide whether this message identifies who's speaking. Never throws — a
 * failure here just means the conversation keeps whatever attribution it
 * already had (or stays unattributed), the same way a distillation failure
 * just means nothing gets remembered.
 */
export async function identifySpeaker(
  env: Env,
  text: string,
  knownPeople: Person[],
  currentPersonName: string | null
): Promise<IdentifyResult> {
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
          { role: "system", content: buildPrompt(knownPeople, currentPersonName) },
          { role: "user", content: text },
        ],
      }),
    });

    if (!res.ok) {
      return { name: null };
    }

    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    const parsed = JSON.parse(data.choices[0].message.content) as Partial<IdentifyResult>;

    if (typeof parsed.name === "string" && parsed.name.trim()) {
      return { name: parsed.name.trim() };
    }
  } catch {
    // Malformed JSON, network error, etc. — treat as "no signal" rather
    // than failing the request.
  }

  return { name: null };
}
