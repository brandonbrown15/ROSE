import { handleChat } from "./chat";
import { handleEnergyRun, handleEnergyStatus, runEnergyOptimization } from "./energy";

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

    if (url.pathname === "/energy/status" && request.method === "GET") {
      return handleEnergyStatus(env);
    }

    if (url.pathname === "/energy/run" && request.method === "POST") {
      return handleEnergyRun(env);
    }

    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
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
