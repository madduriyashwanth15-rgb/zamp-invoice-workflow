// Calendar arithmetic on ISO dates (YYYY-MM-DD), in UTC so a day is always a day.

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const ORD = "(?:st|nd|rd|th)?";

/** A real calendar day as ISO, or null ("31/02/2026" is not a date). Two-digit years are 20yy. */
function isoOf(y: number, m: number, d: number): string | null {
  const year = y < 100 ? 2000 + y : y;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(year, m - 1, d));
  if (t.getUTCFullYear() !== year || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
}

const monthOf = (word: string) => MONTHS[word.toLowerCase().slice(0, 3)];

/**
 * V3c: every calendar date printed in the text, as ISO. Numeric dates are read day first, as Indian invoices print
 * them (12/10/2026, 12-10-26, 12.10.2026); year-first numeric dates (2026-10-12) and dates with the month in words
 * (12 Oct 2026, 12th October, 2026, Oct 12, 2026, 12-Oct-26) are read as written. A reader that swaps the day and
 * the month therefore does not find its date on the page.
 */
export function printedDates(textLayer: string): Set<string> {
  const out = new Set<string>();
  const add = (iso: string | null) => iso && out.add(iso);
  const t = textLayer;
  // Day first, the same separator twice: 12/10/2026, 12-10-26, 12.10.2026, 12 / 10 / 2026.
  for (const m of t.matchAll(/(?<!\d)(\d{1,2})\s*([./-])\s*(\d{1,2})\s*\2\s*(\d{4}|\d{2})(?!\d)/g)) add(isoOf(+m[4], +m[3], +m[1]));
  // Year first: 2026-10-12, 2026/10/12.
  for (const m of t.matchAll(/(?<!\d)(\d{4})([./-])(\d{1,2})\2(\d{1,2})(?!\d)/g)) add(isoOf(+m[1], +m[3], +m[4]));
  // Day, month in words, year: 17 Oct 2026, 14-Oct-2026, 12th of October, 2026, 12 Oct '26.
  const dmy = new RegExp(`(?<!\\d)(\\d{1,2})${ORD}[\\s.,/-]*(?:of\\s+)?${MONTH}\\.?[\\s.,/-]*'?(\\d{4}|\\d{2})(?!\\d)`, "gi");
  for (const m of t.matchAll(dmy)) add(isoOf(+m[3], monthOf(m[2]), +m[1]));
  // Month in words, day, year: Oct 12, 2026, October 12th 2026.
  const mdy = new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})${ORD},?\\s+'?(\\d{4}|\\d{2})(?!\\d)`, "gi");
  for (const m of t.matchAll(mdy)) add(isoOf(+m[3], monthOf(m[1]), +m[2]));
  return out;
}
