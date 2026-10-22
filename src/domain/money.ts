import Decimal from "decimal.js";

// Amounts are integer paise (spec 2, A3); bigint so no money ever touches binary floating point.
export type Paise = bigint;
export type PriceBasis = "exclusive" | "inclusive" | "none";

/** Rupee amount -> paise. Throws if the value is not a whole number of paise. */
export function toPaise(rupees: Decimal.Value): Paise {
  const p = new Decimal(rupees).mul(100);
  if (!p.isInteger()) throw new Error(`not a whole number of paise: ${rupees}`);
  return BigInt(p.toFixed(0));
}

/** Any decimal rupee value -> paise, rounded half-up (for computed values such as total / (1 + rate)). */
export function roundToPaise(rupees: Decimal.Value): Paise {
  return BigInt(new Decimal(rupees).mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
}

/** Paise -> exact rupee string with two decimals ("18880.00"). */
export function paiseToRupees(p: Paise): string {
  const neg = p < 0n;
  const a = neg ? -p : p;
  return `${neg ? "-" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
}

/** Line amount = quantity x unit price, rounded half-up to the paisa (spec 2). */
export function lineAmountPaise(qty: Decimal.Value, unitPrice: Decimal.Value): Paise {
  return roundToPaise(new Decimal(qty).mul(unitPrice));
}

/** V2 tolerance: |a - b| <= tolerance (default Rs 1 = 100 paise, spec 16.4). */
export function withinOneRupee(a: Paise, b: Paise, tolerancePaise: Paise = 100n): boolean {
  const d = a - b;
  return (d < 0n ? -d : d) <= tolerancePaise;
}

/**
 * C1 by cross-multiplication, no rounding (spec 16.4). Inclusive prices are compared against the
 * PO pre-tax price scaled by (1 + rate) instead of dividing the invoice price. `factor` converts an
 * invoice pack price to PO base units (catalog, M3): the PO price is multiplied by it.
 * The tolerance comes from settings.price_tolerance_pct (2% = the 102/98 of spec 16.4).
 */
export function c1Compare(
  price: Decimal.Value,
  poPrice: Decimal.Value,
  basis: PriceBasis,
  gstRate: Decimal.Value,
  factor: Decimal.Value = 1,
  tolerancePct: Decimal.Value = 2,
): "over" | "below" | "within" {
  const p = new Decimal(price).mul(100);
  let po = new Decimal(poPrice).mul(factor);
  if (basis === "inclusive") po = po.mul(new Decimal(1).plus(gstRate));
  if (p.gt(po.mul(new Decimal(100).plus(tolerancePct)))) return "over";
  if (p.lt(po.mul(new Decimal(100).minus(tolerancePct)))) return "below";
  return "within";
}

/** a x (100 + pct) / 100, used for the C3 and M7 caps, exact (compare with `exceedsCap`). */
export function exceedsCap(valuePaise: Paise, capBasePaise: Paise, tolerancePct: Decimal.Value): boolean {
  return new Decimal(valuePaise.toString()).mul(100).gt(new Decimal(capBasePaise.toString()).mul(new Decimal(100).plus(tolerancePct)));
}
