import { handleChat } from "./chat";
import { CHAT_UI_HTML } from "./chatUI";
import { DASHBOARD_HTML } from "./dashboardUI";
import { handleEnergyRun, handleEnergyStatus, runEnergyOptimization } from "./energy";
import {
  createHousehold,
  householdBelongsToIntegrator,
  listIntegratorHouseholds,
  resolveHousehold,
  setHouseholdHaConfig,
  setHouseholdPin,
  verifyHouseholdPin,
} from "./households";
import {
  clearSessionCookie,
  createIntegrator,
  createSessionCookie,
  extractSessionCookie,
  verifyIntegratorLogin,
  verifySessionCookie,
} from "./integrators";

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
  // Legacy global Home Assistant connection — only used as a fallback for
  // the bootstrap 'default' household (see households.ts's
  // getHouseholdHaConfig). Every household added since multi-tenancy
  // configures its own HA connection, stored (encrypted) in D1 instead.
  HA_URL?: string;
  HA_TOKEN?: string;
  // Optional — enables the web_search tool (see search.ts) when set. Absent,
  // ROSE just doesn't offer that tool and answers from what it already knows.
  BRAVE_SEARCH_API_KEY?: string;
  // 32 random bytes as 64 hex chars — encrypts/decrypts each household's own
  // Home Assistant token at rest (crypto.ts's encryptSecret/decryptSecret).
  // Generate with `openssl rand -hex 32`. Required before any
  // integrator-managed household can configure its own HA connection;
  // households.ts's setHouseholdHaConfig throws without it.
  ENCRYPTION_KEY?: string;
  // 32 random bytes as 64 hex chars — signs integrator login session
  // cookies (integrators.ts). Generate with `openssl rand -hex 32`.
  // Required for any /integrator/* route to work at all.
  SESSION_SECRET: string;

  // Plain vars, safe to keep in wrangler.jsonc.
  OPENAI_CHAT_MODEL: string;
  OPENAI_EMBEDDING_MODEL: string;

  // Energy optimization — all optional, all off unless every one of the
  // required fields below is set. See docs/energy.md. Stored as secrets for
  // setup simplicity even where the value isn't actually sensitive.
  ENERGY_OPTIMIZATION_ENABLED?: string; // "true" to enable; anything else (including unset) is off
  OCTOPUS_REGION?: string; // single letter, A-P
  OCTOPUS_PRODUCT_CODE?: string; // optional override; auto-detected if unset
  MET_OFFICE_API_KEY?: string;
  MET_OFFICE_LATITUDE?: string;
  MET_OFFICE_LONGITUDE?: string;
  ROSE_HEATPUMP_ENTITY_ID?: string; // e.g. climate.living_room_heat_pump
  ROSE_ROOM_TEMP_ENTITY_ID?: string; // e.g. sensor.living_room_temperature
  ROSE_HEATING_MIN_TEMP?: string; // °C, hard floor — never overridden for cost
  ROSE_HEATING_MAX_TEMP?: string; // °C, hard ceiling — never overridden for cost

  // Solar (SolarEdge) — independently optional; works with or without the
  // heat pump fields above. A live surplus reading overrides the heat pump
  // target to max (free heat) and, if configured, starts EV charging.
  SOLAREDGE_API_KEY?: string;
  SOLAREDGE_SITE_ID?: string;

  // EV charging — independently optional; requires solar to be configured
  // too (it decides purely off live solar surplus, no price fallback yet).
  // Controlled via Home Assistant, not a direct SolarEdge call — see
  // docs/energy.md for why. *_SERVICE values are "domain.service" strings,
  // e.g. "switch.turn_on" — whatever your HA integration for the charger
  // exposes.
  ROSE_EV_CHARGER_ENTITY_ID?: string;
  ROSE_EV_CHARGER_START_SERVICE?: string;
  ROSE_EV_CHARGER_STOP_SERVICE?: string;
  ROSE_EV_CHARGER_SURPLUS_THRESHOLD_KW?: string; // default 1.4 if unset
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

const JSON_HEADERS = { "content-type": "application/json" };

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: JSON_HEADERS });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS });
}

function jsonOk(body: Record<string, unknown>, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { headers: { ...JSON_HEADERS, ...extraHeaders } });
}

function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization") ?? "";
  const [scheme, token] = auth.split(" ");
  return scheme === "Bearer" && token ? token : null;
}

const PIN_PATTERN = /^\d{4,8}$/;

// Changing the PIN requires proving you know the current one first (which
// falls back to households.ts's documented default, 1003, for a household
// that hasn't set its own yet) — the same reason a phone or alarm panel
// asks for your existing passcode before letting you set a new one: the
// bearer token alone already gates who can reach this endpoint at all, but
// requiring the current PIN too means the PIN itself isn't just one
// request away from being silently swapped out by anything holding that
// token.
async function handleSetPin(request: Request, env: Env, householdId: string): Promise<Response> {
  let body: { current_pin?: string; new_pin?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON body", 400);
  }

  if (typeof body.current_pin !== "string" || !PIN_PATTERN.test(body.current_pin)) {
    return jsonError("'current_pin' must be 4-8 digits", 400);
  }
  if (typeof body.new_pin !== "string" || !PIN_PATTERN.test(body.new_pin)) {
    return jsonError("'new_pin' must be 4-8 digits", 400);
  }

  if (!(await verifyHouseholdPin(env, householdId, body.current_pin))) {
    return jsonError("current_pin is incorrect", 401);
  }

  await setHouseholdPin(env, householdId, body.new_pin);
  return jsonOk({ ok: true });
}

// --- Integrator dashboard API ------------------------------------------------
//
// A separate auth domain from everything above: /integrator/* routes never
// check the household bearer token (extractBearerToken/resolveHousehold) —
// they authenticate via a signed session cookie instead (integrators.ts),
// set on signup/login. See docs/integrators.md.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function handleIntegratorSignup(request: Request, env: Env): Promise<Response> {
  let body: { email?: string; password?: string; name?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON body", 400);
  }

  if (typeof body.email !== "string" || !EMAIL_PATTERN.test(body.email)) {
    return jsonError("a valid 'email' is required", 400);
  }
  if (typeof body.password !== "string" || body.password.length < 8) {
    return jsonError("'password' must be at least 8 characters", 400);
  }

  let integrator;
  try {
    integrator = await createIntegrator(env, body.email, body.password, body.name);
  } catch {
    // The only way createIntegrator throws is a duplicate email — see
    // integrators.ts. Not distinguishing further errors here on purpose:
    // this response shouldn't leak database-shaped detail to a client.
    return jsonError("email already registered", 409);
  }

  return jsonOk({ integrator }, { "set-cookie": await createSessionCookie(env, integrator.id) });
}

async function handleIntegratorLogin(request: Request, env: Env): Promise<Response> {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON body", 400);
  }

  if (typeof body.email !== "string" || typeof body.password !== "string") {
    return jsonError("'email' and 'password' are required", 400);
  }

  const integrator = await verifyIntegratorLogin(env, body.email, body.password);
  if (!integrator) {
    return jsonError("invalid email or password", 401);
  }

  return jsonOk({ integrator }, { "set-cookie": await createSessionCookie(env, integrator.id) });
}

function handleIntegratorLogout(): Response {
  return jsonOk({ ok: true }, { "set-cookie": clearSessionCookie() });
}

async function handleListHouseholds(env: Env, integratorId: string): Promise<Response> {
  const households = await listIntegratorHouseholds(env, integratorId);
  return jsonOk({ households });
}

async function handleCreateHousehold(request: Request, env: Env, integratorId: string): Promise<Response> {
  let body: { name?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON body", 400);
  }

  if (typeof body.name !== "string" || !body.name.trim()) {
    return jsonError("'name' is required", 400);
  }

  // Returns api_key in plaintext — the only time it's available that way,
  // same as any generated credential. The dashboard shows it once, at
  // creation; there's no way to read it back later (see households.ts).
  const household = await createHousehold(env, integratorId, body.name.trim());
  return jsonOk({ household });
}

/** Set (or clear) a household's own Home Assistant connection. Checks the
 * household actually belongs to this integrator first — otherwise one
 * integrator could point another's household at their own HA instance (or
 * anywhere else) just by guessing a household id. */
async function handleSetHouseholdHa(
  request: Request,
  env: Env,
  integratorId: string,
  householdId: string
): Promise<Response> {
  if (!(await householdBelongsToIntegrator(env, householdId, integratorId))) {
    return jsonError("not found", 404);
  }

  let body: { url?: string; token?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON body", 400);
  }

  if (typeof body.url !== "string" || !/^https?:\/\//.test(body.url)) {
    return jsonError("a valid 'url' is required (including http(s)://)", 400);
  }
  if (typeof body.token !== "string" || !body.token) {
    return jsonError("'token' is required", 400);
  }

  try {
    await setHouseholdHaConfig(env, householdId, { url: body.url, token: body.token });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "failed to save", 500);
  }

  return jsonOk({ ok: true });
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

    // Unauthenticated integrator dashboard page — same idea as the chat page
    // above: just markup, served same-origin so it can call /integrator/*
    // with a relative path and have the browser handle the session cookie.
    // No auth at the route level; the page itself shows login/signup until
    // /integrator/households proves there's a valid session.
    if (url.pathname === "/dashboard" && request.method === "GET") {
      return new Response(DASHBOARD_HTML, {
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

    // Integrator dashboard API — a separate auth domain from the household
    // bearer-token routes below, so this is checked and handled entirely
    // before that gate. Signup/login are unauthenticated by nature (that's
    // what they establish); every other /integrator/* route requires a
    // valid session cookie (see integrators.ts).
    if (url.pathname.startsWith("/integrator")) {
      // Every integrator route needs this to sign/verify session cookies —
      // fail with a clear error now rather than an unhandled exception deep
      // in integrators.ts, which would surface as Cloudflare's generic
      // error page (no CORS headers, "failed to fetch" client-side) instead
      // of a real error message.
      if (!env.SESSION_SECRET) {
        return withCors(jsonError("SESSION_SECRET is not configured on this Worker", 500));
      }

      if (url.pathname === "/integrator/signup" && request.method === "POST") {
        return withCors(await handleIntegratorSignup(request, env));
      }
      if (url.pathname === "/integrator/login" && request.method === "POST") {
        return withCors(await handleIntegratorLogin(request, env));
      }
      if (url.pathname === "/integrator/logout" && request.method === "POST") {
        return withCors(handleIntegratorLogout());
      }

      const integratorId = await verifySessionCookie(env, extractSessionCookie(request));
      if (!integratorId) {
        return withCors(unauthorized());
      }

      if (url.pathname === "/integrator/households" && request.method === "GET") {
        return withCors(await handleListHouseholds(env, integratorId));
      }
      if (url.pathname === "/integrator/households" && request.method === "POST") {
        return withCors(await handleCreateHousehold(request, env, integratorId));
      }

      const haMatch = url.pathname.match(/^\/integrator\/households\/([^/]+)\/ha$/);
      if (haMatch && request.method === "POST") {
        return withCors(await handleSetHouseholdHa(request, env, integratorId, haMatch[1]));
      }

      return withCors(jsonError("not found", 404));
    }

    const token = extractBearerToken(request);
    const household = token ? await resolveHousehold(env, token) : null;
    if (!household) {
      return withCors(unauthorized());
    }

    if (url.pathname === "/chat" && request.method === "POST") {
      return withCors(await handleChat(request, env, ctx, household.id));
    }

    // Sets the household's admin PIN (chat.ts's HIGH_RISK_SERVICES gate) —
    // deliberately a separate, non-conversational endpoint rather than
    // something ROSE itself can do from a chat message. Letting the PIN be
    // set or changed through the same self-reported-identity conversation
    // path it's meant to add a check *beyond* would defeat the purpose.
    // Gated only by the household's own bearer token, same as /chat.
    if (url.pathname === "/admin/pin" && request.method === "POST") {
      return withCors(await handleSetPin(request, env, household.id));
    }

    // Energy optimization — see docs/energy.md. Gated only by the
    // household's own bearer token, same as /chat; a no-op response unless
    // ENERGY_OPTIMIZATION_ENABLED="true" and every required Env field is set.
    if (url.pathname === "/energy/status" && request.method === "GET") {
      return withCors(await handleEnergyStatus(env));
    }

    if (url.pathname === "/energy/run" && request.method === "POST") {
      return withCors(await handleEnergyRun(env));
    }

    return withCors(jsonError("not found", 404));
  },

  // Cloudflare Cron Trigger (see wrangler.jsonc `triggers.crons`) — recomputes
  // the heating plan and applies the current slot's target temperature.
  // No-op unless ENERGY_OPTIMIZATION_ENABLED="true" and every required field
  // in Env is set — see docs/energy.md.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (env.ENERGY_OPTIMIZATION_ENABLED !== "true") return;
    ctx.waitUntil(
      runEnergyOptimization(env).catch((err) => console.error("scheduled energy optimization failed", err))
    );
  },
} satisfies ExportedHandler<Env>;
