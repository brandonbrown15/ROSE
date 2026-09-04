import type { HouseholdHaConfig } from "./households";

export interface Device {
  entity_id: string;
  name: string;
  state: string;
}

function baseUrl(ha: HouseholdHaConfig): string {
  return ha.url.replace(/\/+$/, "");
}

function authHeaders(ha: HouseholdHaConfig): Record<string, string> {
  return {
    authorization: `Bearer ${ha.token}`,
    "content-type": "application/json",
  };
}

/**
 * List entities Home Assistant knows about, optionally narrowed to a domain
 * (e.g. "light", "lock", "climate" — the part of an entity_id before the
 * dot) and/or a case-insensitive substring of their friendly name. Used so
 * the model can find the right entity_id before calling `controlDevice` —
 * it doesn't otherwise know what devices exist or what they're called.
 *
 * `ha` is the calling household's own resolved connection (see
 * households.ts's getHouseholdHaConfig) — every household can point at a
 * different Home Assistant instance, so this never reads a global config.
 *
 * Capped at 100 results: a large HA instance can have hundreds of entities,
 * and dumping all of them into the model's context on every lookup would be
 * wasteful — `domain`/`search` are how the model narrows down instead.
 */
export async function listDevices(ha: HouseholdHaConfig, domain?: string, search?: string): Promise<Device[]> {
  const res = await fetch(`${baseUrl(ha)}/api/states`, { headers: authHeaders(ha) });

  if (!res.ok) {
    throw new Error(`Home Assistant /api/states failed: ${res.status} ${await res.text()}`);
  }

  const states = (await res.json()) as {
    entity_id: string;
    state: string;
    attributes?: { friendly_name?: string };
  }[];

  const needle = search?.toLowerCase();

  return states
    .filter((s) => !domain || s.entity_id.startsWith(`${domain}.`))
    .filter((s) => !needle || (s.attributes?.friendly_name ?? s.entity_id).toLowerCase().includes(needle))
    .slice(0, 100)
    .map((s) => ({
      entity_id: s.entity_id,
      name: s.attributes?.friendly_name ?? s.entity_id,
      state: s.state,
    }));
}

/**
 * Call a Home Assistant service — the same mechanism HA's own UI, automations,
 * and its built-in voice assistant all use to actually do anything: turn a
 * light on/off, lock/unlock a door, arm/disarm the alarm, set a thermostat,
 * play media, etc. `domain`/`service` name the action (e.g. "light"/
 * "turn_off"); `entityId` is the target; `data` carries any extra service
 * data (e.g. `{ temperature: 68 }` for climate.set_temperature).
 *
 * `ha` is the calling household's own resolved connection, same as
 * listDevices above.
 *
 * Returns a short description of the resulting state(s), so the model can
 * confirm back to the user what actually happened rather than assuming.
 */
export async function controlDevice(
  ha: HouseholdHaConfig,
  domain: string,
  service: string,
  entityId: string,
  data?: Record<string, unknown>
): Promise<string> {
  const res = await fetch(`${baseUrl(ha)}/api/services/${domain}/${service}`, {
    method: "POST",
    headers: authHeaders(ha),
    body: JSON.stringify({ entity_id: entityId, ...data }),
  });

  if (!res.ok) {
    throw new Error(`Home Assistant service call failed: ${res.status} ${await res.text()}`);
  }

  const changed = (await res.json()) as { entity_id: string; state: string }[];
  if (changed.length === 0) {
    // Not every service call reports a changed entity (e.g. scenes) — the
    // call still succeeded (2xx), so say so rather than implying failure.
    return `${domain}.${service} called on ${entityId} — no state change reported.`;
  }
  return changed.map((s) => `${s.entity_id} -> ${s.state}`).join(", ");
}
