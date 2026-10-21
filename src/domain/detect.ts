import { normText, tokens } from "./normalise";
import type { Settings } from "./types";

// Whole normalised words or phrases (spec 16.1): " lump sum " matches "Lump-Sum", never "lumpsums".
function hasPhrase(text: string, phrase: string): boolean {
  return ` ${tokens(text).join(" ")} `.includes(` ${tokens(phrase).join(" ")} `);
}

/** M7: the description contains a charge keyword. */
export function isChargeLine(description: string, settings: Settings): boolean {
  return settings.charge_keywords.some((k) => hasPhrase(description, k));
}

/** M5: explicit marker only: a marker phrase in description or unit, or a lump-sum unit code. */
export function isLumpSum(description: string, uom: string | null, settings: Settings): boolean {
  const { phrases, units } = settings.lump_sum_markers;
  if (phrases.some((p) => hasPhrase(`${description} ${uom ?? ""}`, p))) return true;
  return units.some((u) => normText(u) === normText(uom));
}
