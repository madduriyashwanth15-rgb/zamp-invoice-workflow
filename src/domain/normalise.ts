// Normalisers from spec 5 and 16.1 (ported from the oracle, validate_test_data.py).

const STOPWORDS = new Set(["a", "an", "the", "of", "and", "for", "with", "per", "as", "to", "in"]);

/** Split on non-alphanumerics, uppercase, strip leading zeros from numeric tokens, join (spec 5). */
export function normInvoiceNumber(s: string | null | undefined): string {
  return (s ?? "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .map((t) => (/^\d+$/.test(t) ? t.replace(/^0+/, "") || "0" : t))
    .join("");
}

/** Invoice-number normalisation, then a leading "PO" removed ("PO-7731" = "7731"). */
export function normPoRef(s: string | null | undefined): string {
  const n = normInvoiceNumber(s);
  return n.startsWith("PO") ? n.slice(2) : n;
}

export function tokens(s: string | null | undefined): string[] {
  return (s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function significantTokens(s: string | null | undefined): Set<string> {
  return new Set(tokens(s).filter((t) => !STOPWORDS.has(t)));
}

/** Lowercase, trimmed; trailing "s" dropped when longer than 3 characters, except "pcs". */
export function normUnit(u: string | null | undefined): string {
  const v = (u ?? "").trim().toLowerCase();
  return v.length > 3 && v.endsWith("s") && v !== "pcs" ? v.slice(0, -1) : v;
}

/** Lowercase letters and digits only (V3, K1 names). */
export function normText(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
