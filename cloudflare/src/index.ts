import { handleChat } from "./chat";

export interface Env {
  DB: D1Database;
  MEMORY_INDEX: VectorizeIndex;

  // Secrets — set with `wrangler secret put <NAME>`, never in wrangler.jsonc.
  OPENAI_API_KEY: string;
  ROSE_API_KEY: string;
  HA_URL?: string;
  HA_TOKEN?: string;

  // Plain vars, safe to keep in wrangler.jsonc.
  OPENAI_CHAT_MODEL: string;
  OPENAI_EMBEDDING_MODEL: string;
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

function isAuthorized(request: Request, env: Env): boolean {
  const auth = request.headers.get("authorization") ?? "";
  const [scheme, token] = auth.split(" ");
  return scheme === "Bearer" && token === env.ROSE_API_KEY;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Unauthenticated health check, useful for the HA config flow's
    // "test connection" step and for uptime monitoring.
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (!isAuthorized(request, env)) {
      return unauthorized();
    }

    if (url.pathname === "/chat" && request.method === "POST") {
      return handleChat(request, env, ctx);
    }

    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  },
} satisfies ExportedHandler<Env>;
