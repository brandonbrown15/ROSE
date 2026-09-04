import type { AgileRate } from "./octopus";
import type { HouseholdTariff, OffPeakWindow } from "./households";

// The alternative to Octopus Agile's live API (octopus.ts) for every other
// UK supplier — see migration 0009's comment for why a live equivalent
// doesn't exist for them. Produces the exact same AgileRate[] shape
// (half-hourly validFrom/validTo/penceIncVat) from a household's own
// manually entered schedule instead of a real API call, so energy.ts's
// buildPlan can rank/classify slots identically regardless of which
// tariff a household is on.

const SLOT_MS = 30 * 60 * 1000;

/** "HH:MM" in Europe/London local time (handles the BST/GMT clock change —
 * off-peak windows like Economy 7's are defined in local clock time, not
 * UTC). hourCycle: "h23" avoids the "24:00" midnight quirk some ICU
 * implementations produce with hour12: false alone. */
function localTimeHHMM(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

/** Whether local time `t` ("HH:MM") falls within window [start, end) —
 * handles a window that wraps past midnight (e.g. "23:00"-"06:00") by
 * treating start > end as "wraps." */
function isInWindow(t: string, w: OffPeakWindow): boolean {
  if (w.start <= w.end) {
    return t >= w.start && t < w.end;
  }
  return t >= w.start || t < w.end;
}

/** Half-hourly rates for [from, to) from a household's manually entered
 * flat/time-of-use tariff — the first matching off-peak window's price, or
 * the flat default rate if none match. Synchronous (no API call), wrapped
 * by the caller alongside the async Octopus/weather fetches. */
export function getManualTariffRates(
  tariff: Extract<HouseholdTariff, { type: "manual" }>,
  from: Date,
  to: Date
): AgileRate[] {
  const rates: AgileRate[] = [];
  let slotStart = new Date(Math.floor(from.getTime() / SLOT_MS) * SLOT_MS);

  while (slotStart.getTime() < to.getTime()) {
    const slotEnd = new Date(slotStart.getTime() + SLOT_MS);
    const hhmm = localTimeHHMM(slotStart);
    const window = tariff.offPeakWindows.find((w) => isInWindow(hhmm, w));
    rates.push({
      validFrom: slotStart.toISOString(),
      validTo: slotEnd.toISOString(),
      penceIncVat: window ? window.pence : tariff.defaultPence,
    });
    slotStart = slotEnd;
  }

  return rates;
}
