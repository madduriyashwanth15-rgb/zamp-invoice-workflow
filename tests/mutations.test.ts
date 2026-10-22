import { describe, expect, it } from "vitest";
import { extractionDiffs } from "@/domain/evaluation/extraction-diff";
import type { Extraction } from "@/domain/extraction-schema";
import { parseExtraction, passRule, runGolden, tests, type GoldenEntry } from "./support/harness";

// Oracle sensitivity (validation_report.txt sections 6-8), re-run through the real pipeline: each mutation must
// change the result the way the matrix footnotes and the S7 note *** say. Proves the golden run can fail.

const get = (res: GoldenEntry[], id: string) => res.find((e) => e.test.test_id === id)!;
const codes = (e: GoldenEntry) => [...new Set(e.run.blocking_codes)].sort();

describe("matrix footnotes and linking guards", () => {
  it("without the M2 proposer (footnote *), S14 -> ON_HOLD LINE_UNMAPPED", async () => {
    const s14 = get(await runGolden({ proposer: null }), "S14");
    expect(s14.run.state).toBe("ON_HOLD");
    expect(codes(s14)).toEqual(["LINE_UNMAPPED"]);
  });
  it("S4 without the token (footnote **) -> ON_HOLD CORRECTION_UNCONFIRMED only; S3 back to ON_HOLD, not superseded", async () => {
    const res = await runGolden({
      emailOverride: (id, e) => (id === "S4" ? { ...e, subject: "Revised invoice INV-552", body_text: "Please find the revised invoice attached." } : e),
    });
    const s4 = get(res, "S4");
    expect(s4.run.state).toBe("ON_HOLD");
    expect(codes(s4)).toEqual(["CORRECTION_UNCONFIRMED"]);
    expect(s4.before.S3).toBe("AWAITING_VENDOR");
    expect(s4.after.S3).toBe("ON_HOLD");
  });
  it("a valid token from an unregistered sender does not link", async () => {
    const s4 = get(await runGolden({ emailOverride: (id, e) => (id === "S4" ? { ...e, from: "someone@unknown.example" } : e) }), "S4");
    expect(codes(s4)).toEqual(["CORRECTION_UNCONFIRMED", "SENDER_UNVERIFIED"]);
    expect(s4.after.S3).toBe("ON_HOLD");
  });
  it("S11 at +2.01% (3.0603) holds PRICE_OVER_TOLERANCE", async () => {
    const s11 = get(await runGolden({ mutate: (e, id) => { if (id === "S11") e.lines[0].unit_price = "3.0603"; return e; } }), "S11");
    expect(codes(s11)).toContain("PRICE_OVER_TOLERANCE");
  });
});

describe("lump-sum rule regression (spec M5 v1.2.2+)", () => {
  it("an ordinary line citing its PO number maps normally: S6a still CLEARED and S6b unchanged", async () => {
    const res = await runGolden({ mutate: (e, id) => { if (id === "S6a") e.lines[0].description = "LPG cylinder 19 kg commercial (refill) as per PO-1003"; return e; } });
    expect(passRule(get(res, "S6a")).problems).toEqual([]);
    expect(passRule(get(res, "S6b")).problems).toEqual([]);
  });
  it("S12 wording without a marker is not lump-sum: still ON_HOLD (fail safe), never BUNDLED, never CLEARED", async () => {
    const s12 = get(await runGolden({ mutate: (e, id) => { if (id === "S12") { e.lines[0].description = "Exhaust hood and duct cleaning as per PO-1007"; e.lines[0].uom = "job"; } return e; } }), "S12");
    expect(s12.run.state).toBe("ON_HOLD");
    expect(codes(s12)).not.toContain("BUNDLED_QUANTITY_UNVERIFIED");
  });
});

describe("S7: misreads fail the test, they are never accepted quietly (matrix note ***)", () => {
  const s7 = tests.get("S7")!;
  const fields = s7.critical_fields as string[];
  const expected = parseExtraction(structuredClone(s7.expected_extraction));
  const cases: [string, (e: Extraction) => void, string | null][] = [
    ["GSTIN Q read as 0", (e) => { e.vendor_gstin = "29ABHPS987601Z3"; }, "VENDOR_GSTIN_MISMATCH"],
    ["unit pcs read as pes", (e) => { e.lines[1].uom = "pes"; }, "UOM_UNSUPPORTED"],
    ["line 1 amount 6,000 read as 6,800", (e) => { e.lines[0].amount = "6800.00"; }, "ARITHMETIC_MISMATCH"],
    ["invented PO reference", (e) => { e.po_reference = "PO-1007"; }, "LINE_UNMAPPED"],
    ["bank last-4 1188 read as 1186", (e) => { e.bank_account_last4 = "1186"; }, "BANK_DETAILS_CHANGED"],
    ["date 15/10 read as 16/10 (no rule fires)", (e) => { e.invoice_date = "2026-10-16"; }, null],
  ];
  it("correct extraction passes with 0 field diffs", async () => {
    const e = get(await runGolden(), "S7");
    expect(passRule(e).problems).toEqual([]);
    expect(extractionDiffs(expected, e.run.extraction!, fields)).toEqual([]);
  });
  for (const [name, mutate, extraCode] of cases) {
    it(`rejects: ${name}`, async () => {
      const e = get(await runGolden({ mutate: (x, id) => { if (id === "S7") mutate(x); return x; } }), "S7");
      const diffs = extractionDiffs(expected, e.run.extraction!, fields);
      expect(diffs.length).toBeGreaterThan(0); // the field check always catches it
      if (extraCode) {
        expect(codes(e)).toContain(extraCode); // and the outcome check fails too
        expect(passRule(e).pass).toBe(false);
      }
      expect(e.run.state).toBe("ON_HOLD"); // a scan never clears (V4)
    });
  }
});
