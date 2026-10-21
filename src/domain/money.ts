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

/** Line amount = quantity x unit price, rounded half-up to the paisa (spec 2). */
export function lineAmountPaise(qty: Decimal.Value, unitPrice: Decimal.Value): Paise {
  return BigInt(new Decimal(qty).mul(unitPrice).mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
}

/** V2 tolerance: |a - b| <= Rs 1 (spec 16.4). */
export function withinOneRupee(a: Paise, b: Paise): boolean {
  const d = a - b;
  return (d < 0n ? -d : d) <= 100n;
}

/**
 * C1 by cross-multiplication, no rounding (spec 16.4). Inclusive prices are compared
 * against the PO pre-tax price scaled by (1 + rate) instead of dividing the invoice price.
 */
export function c1Compare(
  price: Decimal.Value,
  poPrice: Decimal.Value,
  basis: PriceBasis,
  gstRate: Decimal.Value,
): "over" | "below" | "within" {
  const p = new Decimal(price).mul(100);
  const po = basis === "inclusive" ? new Decimal(poPrice).mul(new Decimal(1).plus(gstRate)) : new Decimal(poPrice);
  if (p.gt(po.mul(102))) return "over";
  if (p.lt(po.mul(98))) return "below";
  return "within";
}
