import type { ExtractionLine } from "../extraction-schema";
import { normUnit, significantTokens, tokens } from "../normalise";
import type { CatalogItem, PoLine, PurchaseOrder } from "../types";

// M1 deterministic mapping and the unit verification shared by M1 and M3 (spec 7, 16.1).

/** PO lines a description maps to under M1: item code in the description, or every significant PO token present. */
export function m1Candidates(line: Pick<ExtractionLine, "description">, po: PurchaseOrder): PoLine[] {
  const invoiceTokens = new Set(tokens(line.description));
  return po.lines.filter((pl) => {
    if (pl.line_kind === "charge") return false; // charge lines are only matched by M7
    if (pl.item_code && line.description.toLowerCase().includes(pl.item_code.toLowerCase())) return true;
    const sig = significantTokens(pl.description);
    return sig.size > 0 && [...sig].every((t) => invoiceTokens.has(t));
  });
}

/** M1 maps only when exactly one PO line satisfies the rule. */
export function m1Map(line: Pick<ExtractionLine, "description">, po: PurchaseOrder): PoLine | null {
  const c = m1Candidates(line, po);
  return c.length === 1 ? c[0] : null;
}

export interface UnitVerdict {
  ok: boolean;
  /** Base units per invoice unit (1 for equal units; catalog pack size for a pack). */
  factor: number;
  via: "same unit" | "catalog pack" | null;
  reason: string;
}

/** Units are compatible when equal after normalisation, or when the catalog converts the invoice unit. */
export function verifyUnits(invoiceUom: string | null, poLine: PoLine, catalog: CatalogItem[]): UnitVerdict {
  const inv = normUnit(invoiceUom);
  if (inv && inv === normUnit(poLine.uom)) return { ok: true, factor: 1, via: "same unit", reason: `unit ${inv} equals PO unit` };
  const item = poLine.item_code ? catalog.find((c) => c.item_code === poLine.item_code) : undefined;
  if (item && inv && inv === normUnit(item.pack_uom) && normUnit(item.base_uom) === normUnit(poLine.uom)) {
    return { ok: true, factor: item.pack_size, via: "catalog pack", reason: `1 ${item.pack_uom} = ${item.pack_size} ${item.base_uom} (catalog ${item.item_code})` };
  }
  return {
    ok: false, factor: 1, via: null,
    reason: item ? `invoice unit "${invoiceUom ?? ""}" is neither PO unit "${poLine.uom}" nor catalog pack "${item.pack_uom}"`
      : `invoice unit "${invoiceUom ?? ""}" differs from PO unit "${poLine.uom}" and the catalog has no conversion`,
  };
}

/** Printed pack size in the description ("Pack of 50", "bundle of 100"), if any. */
export function printedPackSize(description: string): number | null {
  const m = description.toLowerCase().match(/(?:pack|bundle|box|carton)\s+of\s+(\d+)/);
  return m ? Number(m[1]) : null;
}

// ---- M3 (spec v1.4): an AI line proposal is accepted only with support the code can check.

/** Size words on a line ("500 ml", "500cc", "2 kg", "3-tier"), normalised to one unit per dimension. */
const MEASURE = /(\d+(?:\.\d+)?)\s*-?\s*(ml|cc|ltr|litre|liter|l|kg|gms|gm|grams|gram|g|mm|cm|m|tier|ply)(?![a-z])/gi;
const SCALE: Record<string, [string, number]> = {
  ml: ["volume", 1], cc: ["volume", 1], l: ["volume", 1000], ltr: ["volume", 1000], litre: ["volume", 1000], liter: ["volume", 1000],
  g: ["mass", 1], gm: ["mass", 1], gms: ["mass", 1], gram: ["mass", 1], grams: ["mass", 1], kg: ["mass", 1000],
  mm: ["length", 1], cm: ["length", 10], m: ["length", 1000], tier: ["tiers", 1], ply: ["ply", 1],
};
const UNIT_WORDS = new Set([...Object.keys(SCALE), "pcs", "pc", "nos", "no", "pack", "packs", "bundle", "box", "unit", "units"]);

function measures(text: string): Map<string, { values: Set<number>; words: string[] }> {
  const out = new Map<string, { values: Set<number>; words: string[] }>();
  for (const m of text.toLowerCase().matchAll(MEASURE)) {
    const [dim, k] = SCALE[m[2]];
    // Sizes are small integers or simple decimals; this is not money, and rounding to 0.001 keeps 0.5 l = 500 ml.
    const v = Math.round(Number(m[1]) * k * 1000) / 1000;
    const e = out.get(dim) ?? { values: new Set<number>(), words: [] };
    e.values.add(v);
    e.words.push(m[0].replace(/\s+/g, " ").trim());
    out.set(dim, e);
  }
  return out;
}

/** Item words: significant tokens that are not numbers or unit words. */
function itemWords(text: string): Set<string> {
  return new Set([...significantTokens(text)].filter((t) => t.length >= 3 && !/^\d/.test(t) && !UNIT_WORDS.has(t)));
}

export interface ProposalSupport {
  ok: boolean;
  reason: string;
}

/**
 * Accept an AI proposal only when the invoice line itself supports it: the PO line's item code is printed, or the
 * catalog pack conversion is backed by a printed pack size the AI read the same way, or the descriptions share an
 * item word. A size printed on both that disagrees (750 ml against 500 ml) rejects the proposal in every case.
 */
export function proposalSupport(
  line: Pick<ExtractionLine, "description">, target: PoLine, catalog: CatalogItem[], packEvidence: boolean,
): ProposalSupport {
  const item = target.item_code ? catalog.find((c) => c.item_code === target.item_code) : undefined;
  const poText = [target.description, item?.description].filter(Boolean).join(" ");
  const inv = measures(line.description);
  const po = measures(poText);
  for (const [dim, a] of inv) {
    const b = po.get(dim);
    if (b && ![...a.values].some((v) => b.values.has(v))) {
      return { ok: false, reason: `size on the invoice line (${a.words.join(", ")}) differs from the PO line (${b.words.join(", ")})` };
    }
  }
  if (target.item_code && line.description.toLowerCase().includes(target.item_code.toLowerCase())) {
    return { ok: true, reason: `PO item code ${target.item_code} printed on the line` };
  }
  if (packEvidence) return { ok: true, reason: "catalog pack size printed on the line and read the same by the AI" };
  const shared = [...itemWords(line.description)].filter((w) => itemWords(poText).has(w));
  if (shared.length) return { ok: true, reason: `item words in common: ${shared.join(", ")}` };
  return { ok: false, reason: "no item code, pack evidence or item word on the invoice line supports this PO line" };
}
