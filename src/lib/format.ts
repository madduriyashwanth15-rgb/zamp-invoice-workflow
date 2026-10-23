// Display formatting. Works on decimal strings so no money value ever passes through floating point.

/** "1880000.5" -> "₹18,80,000.50" (Indian digit grouping). */
export function formatInr(rupees: string | null | undefined): string | null {
  if (rupees == null || rupees === "") return null;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(rupees.trim());
  if (!m) return rupees;
  const [, sign, int, frac = ""] = m;
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${sign}₹${grouped}.${(frac + "00").slice(0, 2)}`;
}

/** "2026-10-12" -> "12 Oct 2026". */
export function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}

/** ISO timestamp -> "22 Oct, 14:05" in India time. */
export function formatTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

/** Sum of decimal rupee strings ("10620.00"), exactly, in paise. Returns a decimal rupee string. */
export function sumRupees(values: (string | null | undefined)[]): string {
  let paise = 0n;
  for (const v of values) {
    const m = v == null ? null : /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(v.trim());
    if (!m) continue;
    const p = BigInt(m[2]) * 100n + BigInt((m[3] ?? "").padEnd(2, "0") || "0");
    paise += m[1] ? -p : p;
  }
  const neg = paise < 0n;
  const a = neg ? -paise : paise;
  return `${neg ? "-" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
}

/** A measured duration (not money): 2400 -> "2.4 s", 23 -> "0.02 s", 3 -> "under 0.01 s". */
export function formatSeconds(ms: number): string {
  if (ms < 10) return "under 0.01 s";
  return ms < 995 ? `${(ms / 1000).toFixed(2)} s` : `${(ms / 1000).toFixed(1)} s`;
}

/** The calendar date in India for a moment (invoices, due dates and ageing use Indian business dates). */
export function istDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
