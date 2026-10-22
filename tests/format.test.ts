import { describe, expect, it } from "vitest";
import { formatDate, formatInr } from "@/lib/format";

describe("display formatting works on strings (no floats)", () => {
  it("Indian digit grouping and two decimals", () => {
    expect(formatInr("18880.00")).toBe("₹18,880.00");
    expect(formatInr("200000")).toBe("₹2,00,000.00");
    expect(formatInr("1880000.5")).toBe("₹18,80,000.50");
    expect(formatInr("999.999")).toBe("₹999.99"); // truncates for display; decisions never use this
    expect(formatInr("0")).toBe("₹0.00");
    expect(formatInr(null)).toBeNull();
  });
  it("dates", () => {
    expect(formatDate("2026-10-12")).toBe("12 Oct 2026");
    expect(formatDate(null)).toBeNull();
  });
});
