import type { Env } from "./index";
import type { HouseholdEnergyConfig } from "./households";
import { getHouseholdHaConfig, listHouseholdsReadyForEnergyOptimization } from "./households";
import { controlDevice, getEntityState } from "./homeAssistant";
import { getAgileRates } from "./octopus";
import { getHourlyForecast, type WeatherPoint } from "./metoffice";
import { getCurrentPowerFlow, type SolarPowerFlow } from "./solaredge";

export interface PlanSlot {
  start: string;
  end: string;
  targetTempC: number;
  pencePerKwh: number;
  outsideTempC: number | null;
  estimatedCop: number | null;
  reason: string;
}

interface EvChargerConfig {
  entityId: string;
  startDomain: string;
  startService: string;
  stopDomain: string;
  stopService: string;
  surplusThresholdKw: number;
}

/**
 * EV charger control is deliberately NOT a direct SolarEdge API call.
 * SolarEdge doesn't publish an official API for controlling their EV
 * charger — every third-party integration that does it (e.g.
 * github.com/briadelour/solaredge-evcharger-ha) reverse-engineers a
 * private endpoint that SolarEdge could change without notice. Rather than
 * embed that fragility here, this calls back into Home Assistant — the
 * same way heat pump control does — against whatever entity/service your
 * chosen HA integration for the charger exposes. That keeps this resilient
 * to SolarEdge's API changing (the HA integration absorbs that, not ROSE)
 * and works with any charger brand, not just SolarEdge's. See
 * docs/energy.md.
 *
 * Solar and EV charging remain single-tenant/global (env vars, not
 * per-household config) and scoped to the 'default' household's Home
 * Assistant connection — see the module comment below and migration
 * 0008's comment for why, unlike heat pump optimization.
 */
function readEvConfig(env: Env): EvChargerConfig | null {
  const { ROSE_EV_CHARGER_ENTITY_ID, ROSE_EV_CHARGER_START_SERVICE, ROSE_EV_CHARGER_STOP_SERVICE } = env;
  if (!ROSE_EV_CHARGER_ENTITY_ID || !ROSE_EV_CHARGER_START_SERVICE || !ROSE_EV_CHARGER_STOP_SERVICE) {
    return null;
  }
  const [startDomain, startService] = ROSE_EV_CHARGER_START_SERVICE.split(".");
  const [stopDomain, stopService] = ROSE_EV_CHARGER_STOP_SERVICE.split(".");
  if (!startDomain || !startService || !stopDomain || !stopService) {
    throw new Error(
      "ROSE_EV_CHARGER_START_SERVICE / ROSE_EV_CHARGER_STOP_SERVICE must be 'domain.service' " +
        "(e.g. switch.turn_on / switch.turn_off — whatever your HA integration for the charger exposes)"
    );
  }
  const surplusThresholdKw = Number(env.ROSE_EV_CHARGER_SURPLUS_THRESHOLD_KW ?? "1.4");
  if (!Number.isFinite(surplusThresholdKw) || surplusThresholdKw < 0) {
    throw new Error("ROSE_EV_CHARGER_SURPLUS_THRESHOLD_KW must be a non-negative number");
  }
  return {
    entityId: ROSE_EV_CHARGER_ENTITY_ID,
    startDomain,
    startService,
    stopDomain,
    stopService,
    surplusThresholdKw,
  };
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
 * Build a heating plan for the next 24h for one household: rank each Agile
 * price slot (that household's own tariff region) by price-adjusted-for-
 * efficiency, and classify the cheapest third as "preheat", the priciest
 * third as "coast", and the rest as "hold comfort". A simple heuristic, not
 * a real thermal model of the house — see docs/energy.md for what a better
 * version would need.
 */
export async function buildPlan(env: Env, config: HouseholdEnergyConfig): Promise<PlanSlot[]> {
  const now = new Date();
  const horizon = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const [rates, weather] = await Promise.all([
    getAgileRates(config.octopusRegion, env.OCTOPUS_PRODUCT_CODE, now, horizon),
    // Weather sharpens the ranking but isn't load-bearing — if Met Office
    // is unreachable/misconfigured, fall back to ranking on price alone
    // rather than failing the whole plan. Also a no-op cleanly if
    // MET_OFFICE_API_KEY (the shared Worker secret) isn't set at all.
    env.MET_OFFICE_API_KEY
      ? getHourlyForecast(env.MET_OFFICE_API_KEY, config.metOfficeLatitude, config.metOfficeLongitude).catch(
          () => [] as WeatherPoint[]
        )
      : Promise.resolve([] as WeatherPoint[]),
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

export interface HeatPumpResult {
  applied: PlanSlot | null;
  plan: PlanSlot[];
}

/**
 * One heat pump optimization cycle for one household: recompute the price/
 * weather plan, store it, and apply the current slot's target — clamped to
 * the configured band, with a safety override that ignores price entirely
 * if the room's already below the minimum. A failed control call (or a
 * missing HA connection) changes nothing and lets the next scheduled run
 * (30 min later) retry — never throws out to the caller.
 */
export async function runHeatPumpOptimization(
  env: Env,
  householdId: string,
  config: HouseholdEnergyConfig
): Promise<HeatPumpResult> {
  const plan = await buildPlan(env, config);
  if (plan.length === 0) {
    return { applied: null, plan: [] };
  }

  await env.DB.batch(
    plan.map((slot) =>
      env.DB.prepare(
        `INSERT INTO energy_plans
           (household_id, slot_start, slot_end, target_temp_c, pence_per_kwh, outside_temp_c, estimated_cop, reason)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
      ).bind(
        householdId,
        slot.start,
        slot.end,
        slot.targetTempC,
        slot.pencePerKwh,
        slot.outsideTempC,
        slot.estimatedCop,
        slot.reason
      )
    )
  );

  const nowISO = new Date().toISOString();
  let applied = plan.find((s) => s.start <= nowISO && nowISO < s.end) ?? plan[0];

  const ha = await getHouseholdHaConfig(env, householdId);
  if (!ha) {
    // Configured (buildPlan ran) but no HA connection resolved for this
    // household right now — store the plan for /energy/status to show,
    // but there's nothing to actually control.
    return { applied, plan };
  }

  try {
    const roomState = await getEntityState(ha, config.roomTempEntityId);
    const roomTempC = Number(roomState.state);
    // Safety floor: if the room is already colder than the configured
    // minimum, override everything above and boost immediately. Comfort/
    // safety beats cost optimization, always.
    if (Number.isFinite(roomTempC) && roomTempC < config.minTempC) {
      applied = {
        ...applied,
        targetTempC: config.maxTempC,
        reason: `safety override — room is ${roomTempC}°C, below the configured minimum`,
      };
    }
    await controlDevice(ha, "climate", "set_temperature", config.heatpumpEntityId, { temperature: applied.targetTempC });
  } catch (err) {
    console.error(`energy optimization: failed to read/set heat pump state for household ${householdId}`, err);
  }

  return { applied, plan };
}

/**
 * Runs a heat pump cycle for every household that's both technically
 * configured and either paying for the add-on or the bootstrap 'default'
 * household (see households.ts's listHouseholdsReadyForEnergyOptimization).
 * One household's failure never blocks another's — each is wrapped
 * independently, same principle as the per-household try/catch inside
 * runHeatPumpOptimization itself.
 */
export async function runAllHeatPumpOptimizations(env: Env): Promise<void> {
  const households = await listHouseholdsReadyForEnergyOptimization(env);
  for (const household of households) {
    try {
      await runHeatPumpOptimization(env, household.id, household.energyConfig);
    } catch (err) {
      console.error(`energy optimization: heat pump cycle failed for household ${household.id}`, err);
    }
  }
}

export interface SolarEvResult {
  solar: SolarPowerFlow | null;
  evCharging: boolean | null;
}

/**
 * Solar surplus tracking + EV charging — still single-tenant (global env
 * vars, not per-household config), scoped to the 'default' household's own
 * Home Assistant connection. Not sold as a billed add-on yet (see
 * docs/energy.md), so this is unchanged from before heat pump optimization
 * became multi-tenant, just rewired onto the shared homeAssistant.ts client
 * instead of the old single-purpose ha.ts (now unused, deleted).
 */
export async function runSolarAndEvOptimization(env: Env): Promise<SolarEvResult> {
  const evConfig = readEvConfig(env);

  let solar: SolarPowerFlow | null = null;
  try {
    solar = await getCurrentPowerFlow(env);
  } catch (err) {
    console.error("energy optimization: failed to read SolarEdge power flow", err);
  }

  let evCharging: boolean | null = null;
  if (evConfig && solar) {
    const ha = await getHouseholdHaConfig(env, "default");
    if (ha) {
      evCharging = solar.surplusKw >= evConfig.surplusThresholdKw;
      try {
        if (evCharging) {
          await controlDevice(ha, evConfig.startDomain, evConfig.startService, evConfig.entityId);
        } else {
          await controlDevice(ha, evConfig.stopDomain, evConfig.stopService, evConfig.entityId);
        }
        await env.DB.prepare(`INSERT INTO energy_events (household_id, kind, detail) VALUES (?1, ?2, ?3)`)
          .bind(
            "default",
            evCharging ? "ev_charge_start" : "ev_charge_stop",
            `surplus=${solar.surplusKw.toFixed(2)}kW threshold=${evConfig.surplusThresholdKw}kW`
          )
          .run();
      } catch (err) {
        // Same principle as the heat pump: don't let a failed control call
        // break the cycle, just retry next time.
        console.error("energy optimization: failed to control EV charger", err);
      }
    }
  }

  return { solar, evCharging };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** GET /energy/status — the calling household's most recently computed
 * plan (and, only for 'default', recent EV events — see runSolarAndEvOptimization). */
export async function handleEnergyStatus(env: Env, householdId: string): Promise<Response> {
  if (env.ENERGY_OPTIMIZATION_ENABLED !== "true") {
    return json({ enabled: false }, 200);
  }
  const [plan, events] = await Promise.all([
    env.DB.prepare(
      `SELECT slot_start, slot_end, target_temp_c, pence_per_kwh, outside_temp_c, estimated_cop, reason
       FROM energy_plans
       WHERE household_id = ?1 AND slot_start >= datetime('now', '-1 hour')
       ORDER BY slot_start ASC
       LIMIT 96`
    )
      .bind(householdId)
      .all(),
    env.DB.prepare(
      `SELECT kind, detail, created_at FROM energy_events WHERE household_id = ?1 ORDER BY created_at DESC LIMIT 20`
    )
      .bind(householdId)
      .all(),
  ]);
  return json({ enabled: true, plan: plan.results, recentEvents: events.results }, 200);
}

/** POST /energy/run — force an immediate recompute + apply for the calling
 * household, e.g. for first-time testing. Requires the household to be
 * technically configured (its integrator has set up its heat pump — see
 * docs/integrators.md) AND, unless it's the bootstrap 'default' household,
 * actually paying for the heating add-on (docs/billing.md) — index.ts
 * checks both before calling this. Also runs the (still global,
 * 'default'-only) solar/EV cycle when the calling household *is* 'default'. */
export async function handleEnergyRun(env: Env, householdId: string, config: HouseholdEnergyConfig): Promise<Response> {
  if (env.ENERGY_OPTIMIZATION_ENABLED !== "true") {
    return json({ error: "energy optimization is not enabled (set the ENERGY_OPTIMIZATION_ENABLED secret to 'true')" }, 409);
  }
  try {
    const heatPump = await runHeatPumpOptimization(env, householdId, config);
    const solarEv = householdId === "default" ? await runSolarAndEvOptimization(env) : { solar: null, evCharging: null };
    return json({ ...heatPump, ...solarEv }, 200);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}
