import Decimal from "decimal.js";
import type { Extraction } from "../extraction-schema";
import { lineAmountPaise, paiseToRupees, roundToPaise, toPaise, withinOneRupee, type Paise, type PriceBasis } from "../money";

// V2 and T3 (spec 16.4). Each basis is a set of comparisons, each within the V2 tolerance (Rs 1).

export interface ArithmeticCheck {
  check: string;
  expected: string;
  actual: string;
  ok: boolean;
}

export interface BasisResult {
  basis: PriceBasis;
  consistent: boolean;
  checks: ArithmeticCheck[];
  /** Set when the basis cannot be applied at all (e.g. inclusive with mixed GST rates). */
  inapplicable?: string;
}

export interface ArithmeticAssessment {
  status: "consistent" | "basis_unclear" | "mismatch";
  stated_basis: PriceBasis | null;
  used_basis: PriceBasis;
  consistent_bases: PriceBasis[];
  /** First failing comparison of the stated basis (mismatch) or the reason the basis is unclear. */
  failed: ArithmeticCheck | null;
  reason: string;
  results: BasisResult[];
}

const p = (v: string | null | undefined): Paise | null => (v == null ? null : toPaise(v));
const zero = (v: Paise | null) => v ?? 0n;

function cmp(check: string, expected: Paise, actual: Paise, tol: Paise): ArithmeticCheck {
  return { check, expected: paiseToRupees(expected), actual: paiseToRupees(actual), ok: withinOneRupee(expected, actual, tol) };
}

function lineChecks(ex: Extraction, tol: Paise): ArithmeticCheck[] {
  return ex.lines
    .filter((l) => l.qty != null && l.unit_price != null)
    .map((l) => cmp(`line ${l.line_no} amount = qty x unit price`, lineAmountPaise(l.qty!, l.unit_price!), toPaise(l.amount), tol));
}

const sumLines = (ex: Extraction): Paise => ex.lines.reduce((s, l) => s + toPaise(l.amount), 0n);

export function taxShown(ex: Extraction): boolean {
  return [ex.tax_total, ex.cgst, ex.sgst, ex.igst].some((v) => v != null && toPaise(v) > 0n);
}

export function checkBasis(ex: Extraction, basis: PriceBasis, tol: Paise): BasisResult {
  const checks = lineChecks(ex, tol);
  const lines = sumLines(ex);
  const subtotal = p(ex.subtotal);
  const total = p(ex.total);
  const components = zero(p(ex.cgst)) + zero(p(ex.sgst)) + zero(p(ex.igst ?? null));
  // Many invoices print only CGST and SGST (or IGST) lines and no separate tax total: then the printed tax is
  // their sum, so the printed components are still checked against the rates and the total.
  const componentsPrinted = [ex.cgst, ex.sgst, ex.igst].some((v) => v != null);
  const tax = p(ex.tax_total) ?? (componentsPrinted ? components : null);

  if (basis === "exclusive") {
    if (subtotal != null) checks.push(cmp("sum of lines = subtotal", lines, subtotal, tol));
    const computedTax = roundToPaise(
      ex.lines.reduce((s, l) => s.plus(new Decimal(l.amount).mul(l.gst_rate ?? 0)), new Decimal(0)),
    );
    if (tax != null) {
      checks.push(cmp("sum of (line amount x GST rate) = tax", computedTax, tax, tol));
      checks.push(cmp("CGST + SGST (or IGST) = tax", components, tax, tol));
    }
    if (total != null) checks.push(cmp("subtotal + tax = total", (subtotal ?? lines) + (tax ?? computedTax), total, tol));
  } else if (basis === "inclusive") {
    const rates = [...new Set(ex.lines.map((l) => new Decimal(l.gst_rate ?? 0).toString()))];
    if (rates.length !== 1) return { basis, consistent: false, checks, inapplicable: `mixed GST rates (${rates.join(", ")})` };
    const rate = new Decimal(rates[0]);
    if (total != null) checks.push(cmp("sum of lines = total", lines, total, tol));
    const t = total ?? lines;
    if (subtotal != null) checks.push(cmp("total / (1 + rate) = taxable value", roundToPaise(new Decimal(t.toString()).div(100).div(rate.plus(1))), subtotal, tol));
    if (subtotal != null && tax != null) checks.push(cmp("taxable value + tax = total", subtotal + tax, t, tol));
  } else {
    if (subtotal != null) checks.push(cmp("sum of lines = subtotal", lines, subtotal, tol));
    if (total != null) checks.push(cmp("sum of lines = total", lines, total, tol));
    checks.push(cmp("tax = 0", 0n, zero(tax) + components, 0n));
  }
  return { basis, consistent: checks.every((c) => c.ok), checks };
}

/** Stated basis consistent: pass; another basis consistent: TAX_BASIS_UNCLEAR; none: ARITHMETIC_MISMATCH. */
export function assessArithmetic(ex: Extraction, tol: Paise): ArithmeticAssessment {
  const all: PriceBasis[] = ["exclusive", "inclusive", "none"];
  const results = all.map((b) => checkBasis(ex, b, tol));
  const consistent = results.filter((r) => r.consistent).map((r) => r.basis);
  const stated = ex.price_basis;
  if (stated == null && taxShown(ex)) {
    return {
      status: "basis_unclear", stated_basis: null, used_basis: "exclusive", consistent_bases: consistent, results,
      failed: null, reason: "tax is shown but the document states no price basis",
    };
  }
  const used: PriceBasis = stated ?? "none";
  const own = results.find((r) => r.basis === used)!;
  if (own.consistent) {
    return { status: "consistent", stated_basis: stated, used_basis: used, consistent_bases: consistent, results, failed: null, reason: `consistent on the ${used} basis` };
  }
  const others = consistent.filter((b) => b !== used);
  if (own.inapplicable || others.length > 0) {
    return {
      status: "basis_unclear", stated_basis: stated, used_basis: used, consistent_bases: consistent, results,
      failed: own.checks.find((c) => !c.ok) ?? null,
      reason: own.inapplicable ?? `stated basis ${used} is inconsistent but ${others.join(" / ")} is consistent`,
    };
  }
  return {
    status: "mismatch", stated_basis: stated, used_basis: used, consistent_bases: consistent, results,
    failed: own.checks.find((c) => !c.ok) ?? null, reason: `arithmetic does not add up on the stated ${used} basis`,
  };
}
