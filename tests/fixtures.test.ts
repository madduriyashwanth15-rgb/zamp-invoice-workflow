import { describe, expect, it } from "vitest";
import { REASON_CODES, SEVERITY } from "@/domain/codes";
import { extractionSchema } from "@/domain/extraction-schema";
import { loadAnswerKey, loadEmail, loadReferenceData, parseCsv } from "@/fixtures/load";

const ref = loadReferenceData();
const answerKey = loadAnswerKey();

describe("reference data equals the test matrix", () => {
  it("6 vendors with matrix GSTIN, bank last-4 and terms", () => {
    expect(ref.vendors.map((v) => [v.vendor_id, v.gstin, v.bank_last4, v.payment_terms_days])).toEqual([
      ["V01", "29AAFCF1234K1Z5", "4417", 30],
      ["V02", "29AAGCC5678M1Z2", "2290", 30],
      ["V03", null, "7781", 7],
      ["V04", "29AABCB4321P1Z8", "5530", 15],
      ["V05", "29ABHPS9876Q1Z3", "1188", 30],
      ["V06", "29AAECU2468R1Z6", "3365", 15],
    ]);
    expect(ref.vendors[0].aliases).toEqual(["FreshPack", "FreshPack Packaging"]);
    expect(ref.vendors[0].registered_senders).toEqual(["billing@freshpack.example"]);
  });
  it("10 POs with matrix subtotals, each equal to the sum of its lines", () => {
    expect(ref.purchaseOrders.map((p) => [p.po_number, p.subtotal_pretax])).toEqual([
      ["PO-1001", 1600000n], ["PO-1002", 1560000n], ["PO-7731", 1000000n], ["PO-1003", 5000000n],
      ["PO-1004", 870000n], ["PO-1005", 600000n], ["PO-1006", 930000n], ["PO-1007", 900000n],
      ["PO-1008", 520000n], ["PO-1009", 1300000n],
    ]);
    for (const po of ref.purchaseOrders) {
      expect(po.lines.reduce((s, l) => s + l.line_amount_pretax, 0n)).toBe(po.subtotal_pretax);
    }
  });
  it("catalog pack sizes", () => {
    expect(ref.catalog.map((c) => [c.item_code, c.pack_size])).toEqual([["CONT-500", 50], ["BAG-M", 100]]);
  });
  it("CSV parser keeps quoted commas and escaped quotes", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([{ a: "x, y", b: 'say "hi"' }]);
  });
});

describe("reason codes", () => {
  it("every code in the answer key exists", () => {
    const used = answerKey.tests.flatMap((t) => [...t.expected.blocking, ...t.expected.info]);
    expect(used.filter((c) => !(c in REASON_CODES))).toEqual([]);
  });
  it("AI_PROPOSAL_REJECTED and MANUAL_HOLD are blocking", () => {
    expect(REASON_CODES.AI_PROPOSAL_REJECTED.kind).toBe("blocking");
    expect(REASON_CODES.MANUAL_HOLD.kind).toBe("blocking");
  });
  it("the severity order lists exactly the blocking codes, once each", () => {
    const blocking = Object.entries(REASON_CODES).filter(([, d]) => d.kind === "blocking").map(([c]) => c);
    expect(new Set(SEVERITY).size).toBe(SEVERITY.length);
    expect([...SEVERITY].sort()).toEqual(blocking.sort());
  });
});

describe("extraction schema (spec 14, A14)", () => {
  const schema = extractionSchema(ref.settings);
  it("all 18 expected extractions parse", () => {
    expect(answerKey.tests).toHaveLength(18);
    for (const t of answerKey.tests) {
      const r = schema.safeParse(t.expected_extraction);
      expect(r.success, `${t.test_id}: ${r.error?.message}`).toBe(true);
    }
  });
  it("S1 with the buyer's GSTIN as vendor_gstin is rejected", () => {
    const s1 = answerKey.tests.find((t) => t.test_id === "S1")!.expected_extraction as object;
    const r = schema.safeParse({ ...s1, vendor_gstin: ref.settings.buyer.gstin });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].path).toEqual(["vendor_gstin"]);
  });
});

describe("email payloads", () => {
  it("substitutes reply tokens and refuses a missing one", () => {
    const s4 = loadEmail("S4", { S3: "R-abc123" });
    expect(s4.subject).toBe("Re: Correction required for invoice INV-552 [Ref R-abc123]");
    expect(s4.body_text).toContain("[Ref R-abc123]");
    expect(() => loadEmail("S4")).toThrow(/no token issued for S3/);
  });
});
