/**
 * Resolves a UK postcode to coordinates via postcodes.io — a free, keyless,
 * open-data (ONS) geocoder. Appropriate specifically because this product's
 * heating optimization is UK-only anyway (Octopus Agile regions, Met Office
 * forecasts — see docs/energy.md), so there's no need for a paid/general
 * geocoder just to turn "SW1A 1AA" into a lat/long.
 *
 * Called once, at setup time (index.ts's handleSetHouseholdEnergy), not on
 * every optimization cycle — the resolved lat/long is what's actually
 * stored and used at runtime (households.ts), so a postcodes.io outage
 * only ever blocks a *new* save, never a household that's already
 * configured.
 */

export interface GeocodedPostcode {
  /** postcodes.io's own normalized formatting (correct casing/spacing) —
   * stored and shown back to the installer rather than whatever raw casing
   * they typed. */
  postcode: string;
  latitude: string;
  longitude: string;
}

interface PostcodesIoResponse {
  status: number;
  result?: {
    postcode?: string;
    latitude?: number;
    longitude?: number;
  };
}

export async function geocodePostcode(rawPostcode: string): Promise<GeocodedPostcode> {
  const trimmed = rawPostcode.trim();
  if (!trimmed) {
    throw new Error("postcode is required");
  }

  let res: Response;
  try {
    res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(trimmed)}`);
  } catch {
    throw new Error("could not reach the postcode lookup service — try again");
  }

  if (res.status === 404) {
    throw new Error(`'${rawPostcode}' doesn't look like a valid UK postcode`);
  }
  if (!res.ok) {
    throw new Error(`postcode lookup failed (postcodes.io returned ${res.status})`);
  }

  const data = (await res.json()) as PostcodesIoResponse;
  const { postcode, latitude, longitude } = data.result ?? {};
  if (typeof postcode !== "string" || typeof latitude !== "number" || typeof longitude !== "number") {
    throw new Error("postcode lookup returned an unexpected response");
  }

  return { postcode, latitude: String(latitude), longitude: String(longitude) };
}
