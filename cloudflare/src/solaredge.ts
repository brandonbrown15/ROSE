import type { Env } from "./index";

export interface SolarPowerFlow {
  pvKw: number;
  loadKw: number;
  /** positive = importing from the grid, negative = exporting to it */
  gridKw: number;
  batteryKw: number | null;
  /** max(0, pvKw - loadKw) — power available for opportunistic use right now */
  surplusKw: number;
}

const SOLAREDGE_BASE = "https://monitoringapi.solaredge.com";

/**
 * Fetch the site's current power flow from SolarEdge's official Monitoring
 * API (documented at https://knowledge-center.solaredge.com — "Monitoring
 * Server API"). Returns null if solar isn't configured, so callers can
 * treat "not installed" and "installed but unreachable" differently (the
 * latter throws).
 *
 * This only reads live, instantaneous power — SolarEdge's Monitoring API is
 * for monitoring, not forecasting, so this can inform "is there surplus
 * right now" decisions but not "will there be surplus at 2pm tomorrow" the
 * way the Agile/Met Office price plan does. See docs/energy.md.
 */
export async function getCurrentPowerFlow(env: Env): Promise<SolarPowerFlow | null> {
  if (!env.SOLAREDGE_API_KEY || !env.SOLAREDGE_SITE_ID) return null;

  const url = `${SOLAREDGE_BASE}/site/${env.SOLAREDGE_SITE_ID}/currentPowerFlow.json?api_key=${env.SOLAREDGE_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`SolarEdge request failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  // Responses are wrapped in a "siteCurrentPowerFlow" key in every SolarEdge
  // sample this was built against; unwrap defensively in case that varies.
  const flow = (data.siteCurrentPowerFlow ?? data) as Record<string, unknown>;
  const unit = typeof flow.unit === "string" ? flow.unit.toLowerCase() : "kw";
  const scale = unit === "w" ? 1 / 1000 : 1; // normalize to kW either way

  const pvKw = readPower(flow, "PV", scale);
  const loadKw = readPower(flow, "LOAD", scale);
  const gridKw = readPower(flow, "GRID", scale);
  const batteryKw = flow.STORAGE ? readPower(flow, "STORAGE", scale) : null;

  if (pvKw === null || loadKw === null || gridKw === null) {
    throw new Error(
      "Could not find PV/LOAD/GRID fields in the SolarEdge response — its API shape may have changed. " +
        "See docs/energy.md for how to inspect a raw response."
    );
  }

  return { pvKw, loadKw, gridKw, batteryKw, surplusKw: Math.max(0, pvKw - loadKw) };
}

function readPower(flow: Record<string, unknown>, key: string, scale: number): number | null {
  const node = flow[key] as Record<string, unknown> | undefined;
  const value = node?.currentPower;
  return typeof value === "number" ? value * scale : null;
}
