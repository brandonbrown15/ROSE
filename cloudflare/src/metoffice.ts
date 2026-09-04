import type { Env } from "./index";

export interface WeatherPoint {
  /** ISO timestamp, UTC */
  time: string;
  /** degrees Celsius */
  outsideTempC: number;
}

const MET_OFFICE_HOURLY_URL = "https://data.hub.api.metoffice.gov.uk/sitespecific/v0/point/hourly";

/**
 * Fetch an hourly outside-temperature forecast for the configured site from
 * Met Office DataHub's Site Specific Global Spot API (free tier: register
 * at https://datahub.metoffice.gov.uk and subscribe to "Site Specific
 * Global Spot").
 *
 * NOTE: Met Office's API reference sits behind an account login, so the
 * exact JSON field name for temperature couldn't be pinned down in advance.
 * Their published parameter glossary calls this "Screen Temperature" (the
 * standard 1.5m-height air temperature reading), so `extractTemperature`
 * looks for `screenTemperature` first and falls back to scanning for any
 * numeric field whose name contains "temperature". If that ever stops
 * matching (Met Office changes their response shape), this throws rather
 * than silently feeding a wrong number into the heating optimizer — see
 * docs/energy.md for how to inspect a raw response and adjust
 * `extractTemperature` if needed.
 */
export async function getHourlyForecast(env: Env): Promise<WeatherPoint[]> {
  if (!env.MET_OFFICE_API_KEY || !env.MET_OFFICE_LATITUDE || !env.MET_OFFICE_LONGITUDE) {
    throw new Error("MET_OFFICE_API_KEY / MET_OFFICE_LATITUDE / MET_OFFICE_LONGITUDE are not fully set");
  }

  const url = new URL(MET_OFFICE_HOURLY_URL);
  url.searchParams.set("latitude", env.MET_OFFICE_LATITUDE);
  url.searchParams.set("longitude", env.MET_OFFICE_LONGITUDE);
  url.searchParams.set("excludeParameterMetadata", "true");

  const res = await fetch(url, {
    headers: { apikey: env.MET_OFFICE_API_KEY, accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Met Office request failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    features?: { properties?: { timeSeries?: Record<string, unknown>[] } }[];
  };

  const timeSeries = data.features?.[0]?.properties?.timeSeries ?? [];

  return timeSeries.map((entry) => {
    const time = entry.time as string | undefined;
    const outsideTempC = extractTemperature(entry);
    if (!time || outsideTempC === null) {
      throw new Error(
        "Could not find a time/temperature field in the Met Office response — its API shape may have " +
          "changed since this was written. See docs/energy.md for how to inspect a raw response."
      );
    }
    return { time, outsideTempC };
  });
}

function extractTemperature(props: Record<string, unknown>): number | null {
  const preferred = ["screenTemperature", "screenTemperatureC", "airTemperature", "temperature"];
  for (const key of preferred) {
    if (typeof props[key] === "number") return props[key] as number;
  }
  for (const [key, value] of Object.entries(props)) {
    if (/temperature/i.test(key) && typeof value === "number") return value;
  }
  return null;
}
