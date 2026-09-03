import { handleChat } from "./chat";
import { CHAT_UI_HTML } from "./chatUI";
import { resolveHousehold } from "./households";

export interface Env {
  DB: D1Database;
  MEMORY_INDEX: VectorizeIndex;

  // Secrets — set with `wrangler secret put <NAME>`, never in wrangler.jsonc.
  OPENAI_API_KEY: string;
  // The bootstrap/default household's bearer token — see households.ts.
  // Every household added after multi-tenancy (docs/households.md)
  // authenticates via its own row in D1 instead; this one secret only
  // covers the single 'default' household migration 0003 backfilled
  // existing data into.
  ROSE_API_KEY: string;
  HA_URL?: string;
  HA_TOKEN?: string;
  // Optional — enables the web_search tool (see search.ts) when set. Absent,
  // ROSE just doesn't offer that tool and answers from what it already knows.
  BRAVE_SEARCH_API_KEY?: string;

  // Plain vars, safe to keep in wrangler.jsonc.
  OPENAI_CHAT_MODEL: string;
  OPENAI_EMBEDDING_MODEL: string;
}

// Permissive CORS: this API is protected by its own bearer-token check
// (resolveHousehold below), not by same-origin/cookie assumptions, so
// allowing any origin doesn't weaken that — it just lets a browser-based
// client (e.g. a standalone chat page) call this API directly, which the
// Cloudflare Workers runtime doesn't allow by default.
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization") ?? "";
  const [scheme, token] = auth.split(" ");
  return scheme === "Bearer" && token ? token : null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Browsers send this before the real cross-origin request (a
    // "preflight") to ask permission — no auth, no body, just headers.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Unauthenticated demo chat page — just markup, the API key the page
    // asks for is only ever used client-side to call /chat directly, which
    // still enforces the real auth check below. Lets ROSE be demoed from
    // any browser (e.g. a phone) by opening this Worker's own URL.
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(CHAT_UI_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // Unauthenticated health check, useful for the HA config flow's
    // "test connection" step and for uptime monitoring.
    if (url.pathname === "/health") {
      return withCors(
        new Response(JSON.stringify({ status: "ok" }), {
          headers: { "content-type": "application/json" },
        })
      );
    }

    const token = extractBearerToken(request);
    const household = token ? await resolveHousehold(env, token) : null;
    if (!household) {
      return withCors(unauthorized());
    }

    if (url.pathname === "/chat" && request.method === "POST") {
      return withCors(await handleChat(request, env, ctx, household.id));
    }

    return withCors(
      new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })
    );
  },
} satisfies ExportedHandler<Env>;
