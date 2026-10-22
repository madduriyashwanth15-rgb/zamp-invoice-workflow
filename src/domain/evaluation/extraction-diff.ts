import Decimal from "decimal.js";
import type { Extraction } from "../extraction-schema";
import { tokens } from "../normalise";

// Field-level extraction check for the live-extraction run (test matrix note ***): amounts, quantities and
// rates compare numerically; identifiers ignore spaces and case; descriptions compare on normalised words;
// a missing value only equals a missing value. Any difference is an extraction defect, even if the outcome is right.

const NUMERIC = new Set(["subtotal", "cgst", "sgst", "igst", "tax_total", "total", "qty", "unit_price", "amount", "gst_rate"]);
const WORDS = new Set(["vendor_name", "description", "buyer_name"]);

export function fieldEqual(name: string, a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (NUMERIC.has(name)) {
    try {
      return new Decimal(String(a)).eq(String(b));
    } catch {
      return false;
    }
  }
  if (WORDS.has(name)) return tokens(String(a)).join(" ") === tokens(String(b)).join(" ");
  return String(a).replace(/\s/g, "").toUpperCase() === String(b).replace(/\s/g, "").toUpperCase();
}

export interface FieldDiff {
  field: string;
  expected: unknown;
  actual: unknown;
}

export function extractionDiffs(expected: Extraction, actual: Extraction, fields: string[]): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const f of fields) {
    if (f.startsWith("lines[].")) {
      const k = f.slice("lines[].".length) as keyof Extraction["lines"][number];
      if (expected.lines.length !== actual.lines.length) {
        if (!diffs.some((d) => d.field === "lines.length")) diffs.push({ field: "lines.length", expected: expected.lines.length, actual: actual.lines.length });
        continue;
      }
      expected.lines.forEach((el, i) => {
        if (!fieldEqual(k, el[k], actual.lines[i][k])) diffs.push({ field: `line ${el.line_no} ${k}`, expected: el[k], actual: actual.lines[i][k] });
      });
    } else {
      const k = f as keyof Extraction;
      if (!fieldEqual(f, expected[k], actual[k])) diffs.push({ field: f, expected: expected[k], actual: actual[k] });
    }
  }
  return diffs;
}
