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
