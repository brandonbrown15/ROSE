import type { Env } from "./index";
import { bytesToHex } from "./crypto";

// --- Standalone Boreas devices ------------------------------------------
//
// See migration 0012's comment and docs/boreas-device.md: a Boreas unit
// lives behind the customer's own home network/NAT, so unlike the
// Home-Assistant control path (where the Worker reaches out to a
// household's own publicly-tunnelled HA instance), the Worker can never
// dial into the device directly. Control flips to the device polling the
// Worker instead — record what it just read, and pick up whatever the
// last optimization cycle decided.

export interface BoreasDevice {
  id: string;
  householdId: string;
  name: string | null;
}

/** Create (or rotate, if one already exists — see migration 0012's
 * UNIQUE(household_id) comment) a household's device credential. Returns
 * the device_key in plaintext — the only time it's available that way,
 * same as households.createHousehold's api_key; the dashboard shows it
 * once, at provisioning time. */
export async function provisionBoreasDevice(
  env: Env,
  householdId: string,
  name: string | null
): Promise<BoreasDevice & { device_key: string }> {
  const deviceKey = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

  const existing = await env.DB.prepare(`SELECT id FROM boreas_devices WHERE household_id = ?1`)
    .bind(householdId)
    .first<{ id: string }>();

  if (existing) {
    await env.DB.prepare(`UPDATE boreas_devices SET device_key = ?1, name = ?2 WHERE id = ?3`)
      .bind(deviceKey, name, existing.id)
      .run();
    return { id: existing.id, householdId, name, device_key: deviceKey };
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO boreas_devices (id, household_id, device_key, name) VALUES (?1, ?2, ?3, ?4)`)
    .bind(id, householdId, deviceKey, name)
    .run();
  return { id, householdId, name, device_key: deviceKey };
}

/** Resolve a device's own bearer token (`Authorization: Bearer
 * <device_key>`) to the device/household it belongs to — the device-auth
 * equivalent of households.ts's resolveHousehold, but a genuinely separate
 * credential space (see migration 0012's comment on why it isn't just
 * reusing the household api_key). */
export async function resolveBoreasDevice(env: Env, deviceKey: string): Promise<BoreasDevice | null> {
  const row = await env.DB.prepare(`SELECT id, household_id, name FROM boreas_devices WHERE device_key = ?1`)
    .bind(deviceKey)
    .first<{ id: string; household_id: string; name: string | null }>();
  if (!row) return null;
  return { id: row.id, householdId: row.household_id, name: row.name };
}

export interface DeviceCommand {
  targetTempC: number | null;
  hvacMode: string | null;
}

/** Record a device's periodic check-in (its own room temperature reading —
 * this is what replaces a Home Assistant room_temp_entity_id sensor for a
 * standalone household) and hand back whatever the most recent
 * optimization cycle decided. Never throws for "nothing decided yet" — a
 * freshly provisioned device polling before its first cron cycle just gets
 * nulls back, same "missing = no-op, not a guess" principle as everywhere
 * else in energy.ts. */
export async function recordDeviceCheckin(env: Env, deviceId: string, roomTempC: number): Promise<DeviceCommand> {
  const row = await env.DB.prepare(
    `UPDATE boreas_devices SET last_room_temp_c = ?1, last_seen_at = datetime('now') WHERE id = ?2
     RETURNING pending_target_temp_c, pending_hvac_mode`
  )
    .bind(roomTempC, deviceId)
    .first<{ pending_target_temp_c: number | null; pending_hvac_mode: string | null }>();

  return { targetTempC: row?.pending_target_temp_c ?? null, hvacMode: row?.pending_hvac_mode ?? null };
}

/** The device's last-reported room temperature — energy.ts's stand-in for
 * Home Assistant's getEntityState(roomTempEntityId) when a household's
 * heatpump_control is 'boreas_device'. Null if the device has never
 * checked in yet. */
export async function getDeviceRoomTempC(env: Env, householdId: string): Promise<number | null> {
  const row = await env.DB.prepare(`SELECT last_room_temp_c FROM boreas_devices WHERE household_id = ?1`)
    .bind(householdId)
    .first<{ last_room_temp_c: number | null }>();
  return row?.last_room_temp_c ?? null;
}

/** Store this cycle's computed target for the household's device to pick
 * up on its next check-in — energy.ts's stand-in for Home Assistant's
 * controlDevice(climate.set_temperature) when heatpump_control is
 * 'boreas_device'. A household with no device row yet (not provisioned,
 * or heatpump_control is still 'home_assistant') is simply a no-op —
 * nothing to update. */
export async function setPendingDeviceCommand(
  env: Env,
  householdId: string,
  targetTempC: number,
  hvacMode: string
): Promise<void> {
  await env.DB.prepare(`UPDATE boreas_devices SET pending_target_temp_c = ?1, pending_hvac_mode = ?2 WHERE household_id = ?3`)
    .bind(targetTempC, hvacMode, householdId)
    .run();
}
