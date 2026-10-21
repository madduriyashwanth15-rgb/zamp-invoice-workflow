import { describe, expect, it } from "vitest";
import { c1Compare, lineAmountPaise, toPaise, withinOneRupee } from "@/domain/money";
import { normInvoiceNumber, normPoRef, normText, normUnit, significantTokens } from "@/domain/normalise";
import { isChargeLine, isLumpSum } from "@/domain/detect";
import { loadReferenceData } from "@/fixtures/load";

const { settings } = loadReferenceData();

describe("normalisers (spec 5, 16.1)", () => {
  it("invoice numbers", () => {
    expect(normInvoiceNumber("FP/2026/418")).toBe(normInvoiceNumber("FP-2026-0418"));
    expect(normInvoiceNumber("FP-2026-0418")).toBe("FP2026418");
    expect(normInvoiceNumber("INV-000")).toBe("INV0");
  });
  it("PO references", () => {
    expect(normPoRef("7731")).toBe(normPoRef("PO-7731"));
    expect(normPoRef("po 1003")).toBe("1003");
  });
  it("significant tokens drop stopwords", () => {
    expect([...significantTokens("Exhaust hood and duct cleaning as per the PO")]).toEqual([
      "exhaust", "hood", "duct", "cleaning", "po",
    ]);
  });
  it("units", () => {
    expect(normUnit("bottles")).toBe("bottle");
    expect(normUnit(" Rolls ")).toBe("roll");
    expect(normUnit("pcs")).toBe("pcs");
    expect(normUnit("kg")).toBe("kg");
    expect(normUnit("cyl")).toBe("cyl");
  });
  it("normalised text keeps lowercase letters and digits only", () => {
    expect(normText("FP-2026-0418, Rs. 18,880.00")).toBe("fp20260418rs1888000");
  });
});

describe("money (A3, spec 16.4)", () => {
  it("2,000 x 3.045 = 6,090.00 exactly", () => {
    expect(lineAmountPaise("2000", "3.045")).toBe(609000n);
  });
  it("line amounts round half-up to the paisa", () => {
    expect(lineAmountPaise("1", "0.005")).toBe(1n);
    expect(lineAmountPaise("3", "0.3333")).toBe(100n);
    expect(lineAmountPaise("1.5", "0.0033")).toBe(0n);
  });
  it("toPaise rejects fractions of a paisa", () => {
    expect(toPaise("18880.00")).toBe(1888000n);
    expect(() => toPaise("1.005")).toThrow();
  });
  it("withinOneRupee is inclusive at Rs 1", () => {
    expect(withinOneRupee(1000n, 1100n)).toBe(true);
    expect(withinOneRupee(1101n, 1000n)).toBe(false);
  });
  it("C1 boundaries vs 3.00", () => {
    expect(c1Compare("3.06", "3.00", "exclusive", "0.18")).toBe("within"); // exactly +2.00%
    expect(c1Compare("3.0603", "3.00", "exclusive", "0.18")).toBe("over");
    expect(c1Compare("2.94", "3.00", "exclusive", "0.18")).toBe("within"); // exactly -2.00%
    expect(c1Compare("2.9399", "3.00", "exclusive", "0.18")).toBe("below");
  });
  it("C1 inclusive: S13 prices 9.44 and 14.16 at 18% are within 8.00 and 12.00", () => {
    expect(c1Compare("9.44", "8.00", "inclusive", "0.18")).toBe("within");
    expect(c1Compare("14.16", "12.00", "inclusive", "0.18")).toBe("within");
    expect(c1Compare("9.80", "8.00", "inclusive", "0.18")).toBe("over"); // 9.80 / 1.18 = 8.305 > 8.16
  });
});

describe("detection (M5, M7)", () => {
  // validation_report.txt section 7: the 9 lump-sum detection cases.
  const lumpSumCases: [string, string, boolean][] = [
    ["Exhaust hood and duct cleaning as per PO-1007 (lump sum)", "LS", true],
    ["Annual kitchen maintenance - Lump-Sum", "job", true],
    ["Hood cleaning LUMPSUM", "job", true],
    ["Kitchen deep clean", "LS", true],
    ["LPG cylinder 19 kg commercial (refill) as per PO-1003", "cyl", false],
    ["Food container 500 ml - PO-1001 line 1", "pcs", false],
    ["Exhaust hood and duct cleaning as per PO-1007", "job", false],
    ["Carry bag medium - bundle of 100", "bundle", false],
    ["Duct cleaning", "job", false],
  ];
  it.each(lumpSumCases)("isLumpSum(%s, %s) = %s", (desc, uom, want) => {
    expect(isLumpSum(desc, uom, settings)).toBe(want);
  });
  it("charge lines", () => {
    expect(isChargeLine("Delivery charges", settings)).toBe(true);
    expect(isChargeLine("Service charge (10%)", settings)).toBe(true);
    expect(isChargeLine("FreshPack", settings)).toBe(false);
    expect(isChargeLine("Pack of 50", settings)).toBe(false);
    expect(isChargeLine("Takeaway box 500cc - Pack of 50", settings)).toBe(false);
  });
});
