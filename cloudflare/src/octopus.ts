export interface AgileRate {
  /** ISO timestamp, UTC, inclusive */
  validFrom: string;
  /** ISO timestamp, UTC, exclusive */
  validTo: string;
  /** pence per kWh, inc. VAT */
  penceIncVat: number;
}

const OCTOPUS_BASE = "https://api.octopus.energy/v1";

interface OctopusProduct {
  code: string;
  available_from: string;
  available_to: string | null;
}

async function fetchAllPages<T>(initialUrl: string): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = initialUrl;
  while (url) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Octopus request failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { results: T[]; next: string | null };
    out.push(...data.results);
    url = data.next;
  }
  return out;
}

/**
 * Octopus periodically retires and relaunches the Agile product under a new
 * code (e.g. AGILE-24-10-01), so we don't hardcode one. If
 * OCTOPUS_PRODUCT_CODE isn't set, find whichever "AGILE-*" import product is
 * currently live and use that.
 */
async function currentAgileProductCode(): Promise<string> {
  const products = await fetchAllPages<OctopusProduct>(`${OCTOPUS_BASE}/products/?is_variable=true`);
  const now = new Date().toISOString();

  const live = products
    .filter((p) => p.code.startsWith("AGILE-") && p.available_from <= now && (!p.available_to || p.available_to > now))
    .sort((a, b) => (a.available_from < b.available_from ? 1 : -1));

  if (live.length === 0) {
    throw new Error(
      "No currently-live Octopus Agile product found automatically — set OCTOPUS_PRODUCT_CODE explicitly " +
        "(look it up at https://octopus.energy/agile/ or via GET /v1/products/)."
    );
  }
  return live[0].code;
}

/**
 * Fetch Agile half-hourly unit rates covering [from, to) for one household's
 * region. No API key is needed — Octopus's tariff rate data is public.
 * `region` is per-household (which UK electricity distribution region the
 * home is in — see households.ts's HouseholdEnergyConfig); `productCodeOverride`
 * stays a global, optional override (the Agile product code is the same
 * nationally, only the region letter varies per home) — leave it unset to
 * auto-detect the currently-live one.
 */
export async function getAgileRates(
  region: string,
  productCodeOverride: string | undefined,
  from: Date,
  to: Date
): Promise<AgileRate[]> {
  const productCode = productCodeOverride || (await currentAgileProductCode());
  const tariffCode = `E-1R-${productCode}-${region}`;

  const url = new URL(`${OCTOPUS_BASE}/products/${productCode}/electricity-tariffs/${tariffCode}/standard-unit-rates/`);
  url.searchParams.set("period_from", from.toISOString());
  url.searchParams.set("period_to", to.toISOString());

  const results = await fetchAllPages<{ valid_from: string; valid_to: string; value_inc_vat: number }>(url.toString());

  return results
    .map((r) => ({ validFrom: r.valid_from, validTo: r.valid_to, penceIncVat: r.value_inc_vat }))
    .sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1));
}
