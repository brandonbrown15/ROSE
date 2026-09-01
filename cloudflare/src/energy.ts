import type { Env } from "./index";
import { HomeAssistantClient } from "./ha";
import { getAgileRates } from "./octopus";
import { getHourlyForecast, type WeatherPoint } from "./metoffice";

export interface PlanSlot {
  start: string;
  end: string;
  targetTempC: number;
  pencePerKwh: number;
  outsideTempC: number | null;
  estimatedCop: number | null;
  reason: string;
}

interface EnergyConfig {
  heatpumpEntityId: string;
  roomTempEntityId: string;
  minTempC: number;
  maxTempC: number;
}

function readConfig(env: Env): EnergyConfig | null {
  const { ROSE_HEATPUMP_ENTITY_ID, ROSE_ROOM_TEMP_ENTITY_ID, ROSE_HEATING_MIN_TEMP, ROSE_HEATING_MAX_TEMP } = env;
  if (!ROSE_HEATPUMP_ENTITY_ID || !ROSE_ROOM_TEMP_ENTITY_ID || !ROSE_HEATING_MIN_TEMP || !ROSE_HEATING_MAX_TEMP) {
    return null;
  }
  const minTempC = Number(ROSE_HEATING_MIN_TEMP);
  const maxTempC = Number(ROSE_HEATING_MAX_TEMP);
  if (!Number.isFinite(minTempC) || !Number.isFinite(maxTempC) || minTempC >= maxTempC) {
    throw new Error("ROSE_HEATING_MIN_TEMP / ROSE_HEATING_MAX_TEMP are missing or invalid (min must be < max)");
  }
  return { heatpumpEntityId: ROSE_HEATPUMP_ENTITY_ID, roomTempEntityId: ROSE_ROOM_TEMP_ENTITY_ID, minTempC, maxTempC };
}

/**
 * Rough, generic air-source heat pump COP (coefficient of performance)
 * curve — NOT Samsung manufacturer data, just a widely-cited rule-of-thumb
 * shape (roughly 4.5 at 10°C outside air, dropping to roughly 2.2 at -5°C).
 * Used only to rank price slots by *effective* cost-per-unit-heat rather
 * than raw electricity price, since a heat pump gets less efficient as it
 * gets colder outside. Replace with your specific model's published COP
 * curve for a real improvement — see docs/energy.md.
 */
function approximateCop(outsideTempC: number): number {
  const t0 = -5,
    cop0 = 2.2;
  const t1 = 10,
    cop1 = 4.5;
  const cop = cop0 + ((cop1 - cop0) / (t1 - t0)) * (outsideTempC - t0);
  return Math.min(5.0, Math.max(1.5, cop));
}

function nearestWeather(weather: WeatherPoint[], atISO: string): WeatherPoint | null {
  if (weather.length === 0) return null;
  const at = new Date(atISO).getTime();
  let best = weather[0];
  let bestDelta = Math.abs(new Date(best.time).getTime() - at);
  for (const w of weather) {
    const delta = Math.abs(new Date(w.time).getTime() - at);
    if (delta < bestDelta) {
      best = w;
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * Build a heating plan for the next 24h: rank each Agile price slot by
 * price-adjusted-for-efficiency, and classify the cheapest third as
 * "preheat", the priciest third as "coast", and the rest as "hold
 * comfort". This is a simple heuristic, not a real thermal model of the
 * house — see docs/energy.md for what a better version would need.
 */
export async function buildPlan(env: Env): Promise<PlanSlot[] | null> {
  const config = readConfig(env);
  if (!config) return null;

  const now = new Date();
  const horizon = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const [rates, weather] = await Promise.all([
    getAgileRates(env, now, horizon),
    // Weather sharpens the ranking but isn't load-bearing — if Met Office
    // is unreachable or misconfigured, fall back to ranking on price alone
    // rather than failing the whole plan.
    getHourlyForecast(env).catch(() => [] as WeatherPoint[]),
  ]);

  if (rates.length === 0) return [];

  const comfortTempC = (config.minTempC + config.maxTempC) / 2;

  const scored = rates.map((rate) => {
    const w = nearestWeather(weather, rate.validFrom);
    const cop = w ? approximateCop(w.outsideTempC) : null;
    const effectiveCost = cop ? rate.penceIncVat / cop : rate.penceIncVat;
    return { rate, weather: w, cop, effectiveCost };
  });

  const byCost = [...scored].sort((a, b) => a.effectiveCost - b.effectiveCost);
  const third = Math.ceil(byCost.length / 3);
  const boost = new Set(byCost.slice(0, third).map((s) => s.rate.validFrom));
  const coast = new Set(byCost.slice(byCost.length - third).map((s) => s.rate.validFrom));

  return scored.map(({ rate, weather: w, cop }) => {
    let targetTempC = comfortTempC;
    let reason = "mid-priced slot — holding comfort temperature";
    if (boost.has(rate.validFrom)) {
      targetTempC = config.maxTempC;
      reason = "cheap/efficient slot — preheating";
    } else if (coast.has(rate.validFrom)) {
      targetTempC = config.minTempC;
      reason = "expensive/inefficient slot — coasting on stored heat";
    }
    // Always clamp to the configured band, no matter what — this is the
    // hard safety limit, not just a heuristic default.
    targetTempC = Math.min(config.maxTempC, Math.max(config.minTempC, targetTempC));
    return {
      start: rate.validFrom,
      end: rate.validTo,
      targetTempC,
      pencePerKwh: rate.penceIncVat,
      outsideTempC: w?.outsideTempC ?? null,
      estimatedCop: cop,
      reason,
    };
  });
}

/**
 * Recompute the plan, store it, and apply the current slot's target
 * temperature to the heat pump — clamped to the configured band, with a
 * safety override that ignores price entirely if the room has already
 * dropped below the configured minimum.
 */
export async function runEnergyOptimization(env: Env): Promise<{ applied: PlanSlot | null; plan: PlanSlot[] }> {
  const config = readConfig(env);
  if (!config) return { applied: null, plan: [] };

  const plan = await buildPlan(env);
  if (!plan || plan.length === 0) return { applied: null, plan: [] };

  await env.DB.batch(
    plan.map((slot) =>
      env.DB.prepare(
        `INSERT INTO energy_plans
           (slot_start, slot_end, target_temp_c, pence_per_kwh, outside_temp_c, estimated_cop, reason)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      ).bind(slot.start, slot.end, slot.targetTempC, slot.pencePerKwh, slot.outsideTempC, slot.estimatedCop, slot.reason)
    )
  );

  const nowISO = new Date().toISOString();
  const current = plan.find((s) => s.start <= nowISO && nowISO < s.end) ?? plan[0];

  let appliedTempC = current.targetTempC;
  let appliedReason = current.reason;

  const ha = new HomeAssistantClient(env);
  if (ha.isConfigured) {
    try {
      const roomState = (await ha.getState(config.roomTempEntityId)) as { state: string };
      const roomTempC = Number(roomState.state);
      // Safety floor: if the room is already colder than the configured
      // minimum, override the schedule and boost immediately regardless of
      // price. Comfort/safety beats cost optimization, always.
      if (Number.isFinite(roomTempC) && roomTempC < config.minTempC) {
        appliedTempC = config.maxTempC;
        appliedReason = `safety override — room is ${roomTempC}°C, below the configured minimum`;
      }
      await ha.callService("climate", "set_temperature", {
        entity_id: config.heatpumpEntityId,
        temperature: appliedTempC,
      });
    } catch (err) {
      // A failed control call shouldn't take down anything else — the next
      // scheduled run (30 min later) just tries again.
      console.error("energy optimization: failed to read/set heat pump state", err);
    }
  }

  return { applied: { ...current, targetTempC: appliedTempC, reason: appliedReason }, plan };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** GET /energy/status — the most recently computed plan. */
export async function handleEnergyStatus(env: Env): Promise<Response> {
  if (env.ENERGY_OPTIMIZATION_ENABLED !== "true") {
    return json({ enabled: false }, 200);
  }
  const { results } = await env.DB.prepare(
    `SELECT slot_start, slot_end, target_temp_c, pence_per_kwh, outside_temp_c, estimated_cop, reason
     FROM energy_plans
     WHERE slot_start >= datetime('now', '-1 hour')
     ORDER BY slot_start ASC
     LIMIT 96`
  ).all();
  return json({ enabled: true, plan: results }, 200);
}

/** POST /energy/run — force an immediate recompute + apply, e.g. for first-time testing. */
export async function handleEnergyRun(env: Env): Promise<Response> {
  if (env.ENERGY_OPTIMIZATION_ENABLED !== "true") {
    return json({ error: "energy optimization is not enabled (set the ENERGY_OPTIMIZATION_ENABLED secret to 'true')" }, 409);
  }
  try {
    return json(await runEnergyOptimization(env), 200);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}
