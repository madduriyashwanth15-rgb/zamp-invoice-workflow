// JSON with bigint (paise) support: a bigint is stored as {"$bigint":"12345"} and read back as a bigint.

export function encode(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? { $bigint: v.toString() } : v));
}

export function decode<T>(text: string): T {
  return JSON.parse(text, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof v.$bigint === "string" && Object.keys(v).length === 1) return BigInt(v.$bigint);
    return v;
  }) as T;
}
