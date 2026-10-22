import { describe, expect, it } from "vitest";
import { toPaise } from "@/domain/money";
import { reference } from "./support/harness";
import { codes, evalDirect, extractionOf, infos, prior } from "./support/direct";

// Rule-level tests from the test matrix "Rule unit tests" and the A-series (spec v1.3 section 17),
// on the pure engine. Text layer defaults to the extraction's own values so V3 is isolated.

const S1_CHAIN = "V01|FP2026418"; // normalised chain key for FreshPack FP-2026-0418 (leading zero stripped)

describe("G1-G3 classification (F4 at engine level)", () => {
  it("AI says quotation but the title says TAX INVOICE -> CLASSIFICATION_CONFLICT", async () => {
    const e = extractionOf("S1");
    e.doc_type = "quotation";
    expect(codes(await evalDirect(e))).toEqual(["CLASSIFICATION_CONFLICT"]);
  });
  it("credit note -> CREDIT_NOTE_UNSUPPORTED", async () => {
    const e = extractionOf("S1");
    e.doc_type = "credit_note";
    expect(codes(await evalDirect(e))).toContain("CREDIT_NOTE_UNSUPPORTED");
  });
  it("row 5: G1 bypass processes a quotation as an invoice (every other check runs)", async () => {
    const r = await evalDirect(extractionOf("S9"), { document: { g1_bypassed: true } });
    expect(r.outcome).not.toBe("SKIPPED");
    expect(r.stages.find((s) => s.stage === "classify")!.notes.join(" ")).toMatch(/bypassed/);
  });
});

describe("V1-V5 document checks", () => {
  it("F2: missing invoice number -> MISSING_REQUIRED_FIELD", async () => {
    const e = extractionOf("S1");
    e.invoice_number = null;
    expect(codes(await evalDirect(e))).toContain("MISSING_REQUIRED_FIELD");
  });
  it("F3: total absent from the text layer -> EVIDENCE_NOT_FOUND", async () => {
    const e = extractionOf("S1");
    const r = await evalDirect(e, { document: { text_layer: "TAX INVOICE FP-2026-0418 no amounts here at all, just some words to pass fifty", has_text_layer: true } });
    expect(codes(r)).toContain("EVIDENCE_NOT_FOUND");
  });
  it("A14: an internally consistent misread of line 2 (3.05, 3,050) is caught by V3, not CLEARED", async () => {
    const e = extractionOf("S1");
    e.lines[1].unit_price = "3.05";
    e.lines[1].amount = "3050.00";
    Object.assign(e, { subtotal: "16050.00", tax_total: "2889.00", cgst: "1444.50", sgst: "1444.50", total: "18939.00" });
    const { readFileSync } = await import("node:fs");
    const { readTextLayer } = await import("@/server/pdf-text");
    const pdf = await readTextLayer(new Uint8Array(readFileSync("zamp-ps1-test-data-v2.1/test-data/invoices/S01_FreshPack_FP-2026-0418.pdf")), "application/pdf");
    const r = await evalDirect(e, { document: { text_layer: pdf.text, has_text_layer: true } });
    expect(r.outcome).toBe("ON_HOLD");
    expect(codes(r)).toEqual(["EVIDENCE_NOT_FOUND"]);
  });
  it("V5: date more than 1 day in the future -> DATE_INVALID", async () => {
    const e = extractionOf("S1");
    e.invoice_date = "2026-10-24";
    expect(codes(await evalDirect(e, { today: "2026-10-22" }))).toContain("DATE_INVALID");
    e.invoice_date = "2026-10-23";
    expect(codes(await evalDirect(e, { today: "2026-10-22" }))).not.toContain("DATE_INVALID");
  });
  it("V4: no text layer -> SCAN_UNVERIFIED even when everything else passes", async () => {
    const r = await evalDirect(extractionOf("S1"), { document: { text_layer: "", has_text_layer: false } });
    expect(codes(r)).toEqual(["SCAN_UNVERIFIED"]);
  });
});

describe("A9: price basis (T3, spec 16.4)", () => {
  it("stated inclusive but only exclusive arithmetic is consistent -> TAX_BASIS_UNCLEAR, not ARITHMETIC_MISMATCH", async () => {
    const e = extractionOf("S1");
    e.price_basis = "inclusive";
    const c = codes(await evalDirect(e));
    expect(c).toContain("TAX_BASIS_UNCLEAR");
    expect(c).not.toContain("ARITHMETIC_MISMATCH");
  });
  it("tax shown with no stated basis -> TAX_BASIS_UNCLEAR", async () => {
    const e = extractionOf("S1");
    e.price_basis = null;
    expect(codes(await evalDirect(e))).toContain("TAX_BASIS_UNCLEAR");
  });
  it("no basis and no tax (Kumar style) is treated as none and passes", async () => {
    const e = extractionOf("S4");
    e.price_basis = null;
    expect(codes(await evalDirect(e))).not.toContain("TAX_BASIS_UNCLEAR");
  });
  it("S10 printed total wrong on every basis -> ARITHMETIC_MISMATCH", async () => {
    expect(codes(await evalDirect(extractionOf("S10")))).toEqual(["ARITHMETIC_MISMATCH"]);
  });
});

describe("K1-K4 vendor, sender, bank", () => {
  it("T17 at engine level: an upload clears; K3 recorded not evaluated with the uploader's demo name", async () => {
    const r = await evalDirect(extractionOf("S1"), { document: { source: "upload", sender_email: null, uploader_display_name: "Divya" } });
    expect(r.outcome).toBe("CLEARED");
    expect(r.stages.find((s) => s.stage === "vendor")!.notes.join(" ")).toContain("not evaluated: internal upload by Divya (demo identity)");
  });
  it("AP-forwarder allowlist sender passes K3", async () => {
    const r = await evalDirect(extractionOf("S1"), { document: { sender_email: "ap-forwarder@spiceroute.example" } });
    expect(r.outcome).toBe("CLEARED");
  });
  it("K4: bank not printed -> info BANK_NOT_SHOWN, still CLEARED", async () => {
    const e = extractionOf("S1");
    e.bank_account_last4 = null;
    const r = await evalDirect(e);
    expect(r.outcome).toBe("CLEARED");
    expect(infos(r)).toContain("BANK_NOT_SHOWN");
  });
  it("K2: name matches, GSTIN differs -> VENDOR_GSTIN_MISMATCH", async () => {
    const e = extractionOf("S1");
    e.vendor_gstin = "29AAFCF1234K1Z9";
    expect(codes(await evalDirect(e))).toContain("VENDOR_GSTIN_MISMATCH");
  });
  it("BANK_DETAILS_CHANGED evidence tells the reviewer to phone the master number", async () => {
    const e = extractionOf("S1");
    e.bank_account_last4 = "0091";
    const f = (await evalDirect(e)).blocking.find((x) => x.code === "BANK_DETAILS_CHANGED")!;
    expect(f.evidence.action).toMatch(/vendor master number \+91 80 0000 1001/);
  });
});

describe("A7: D1 exactness and D2/D3 precedence", () => {
  const s1Prior = (state: "CLEARED" | "ON_HOLD" | "APPROVED" | "REJECTED", extra: object = {}) =>
    prior({ run_id: `run-${state}`, state, vendor_id: "V01", chain_key: S1_CHAIN, invoice_date: "2026-10-12", total_paise: toPaise("18880.00"), ...extra });
  it("a Rs 0.01 difference is not a duplicate: D3 POSSIBLE_DOUBLE_BILLING instead", async () => {
    const e = extractionOf("S5");
    e.total = "18880.01";
    const r = await evalDirect(e, { priorRuns: [s1Prior("CLEARED")] });
    expect(r.outcome).toBe("ON_HOLD");
    expect(codes(r)).toEqual(["POSSIBLE_DOUBLE_BILLING"]);
    expect(r.dispute).toEqual({ counterpart_run_id: "run-CLEARED", counterpart_state: "CLEARED", counterpart_exported: false });
  });
  it("exact date and total -> REJECTED DUPLICATE_INVOICE", async () => {
    const r = await evalDirect(extractionOf("S5"), { priorRuns: [s1Prior("CLEARED")] });
    expect(r.outcome).toBe("REJECTED");
  });
  it("a payable run in the chain beats a held one: D3, not D2 (no correction link)", async () => {
    const e = extractionOf("S1");
    e.invoice_date = "2026-10-13";
    const r = await evalDirect(e, { priorRuns: [s1Prior("APPROVED", { run_id: "run-A" }), s1Prior("ON_HOLD", { run_id: "run-H", invoice_date: "2026-10-11" })] });
    expect(codes(r)).toEqual(["POSSIBLE_DOUBLE_BILLING"]);
    expect(r.correction).toBeNull();
  });
  it("A8: the new run's C2/C3 exclude an unexported counterpart's consumption (replacement reachable)", async () => {
    const e = extractionOf("S6a");
    e.invoice_date = "2026-10-11";
    const counterpart = prior({ run_id: "run-6a", state: "APPROVED", vendor_id: "V04", chain_key: "V04|BF3301", invoice_date: "2026-10-10",
      total_paise: toPaise("35400.00"), consumption: [{ po_number: "PO-1003", line_no: 1, base_qty: "15", amount_paise: toPaise("30000.00") }] });
    const other = prior({ run_id: "run-x", state: "CLEARED", vendor_id: "V04", chain_key: "V04|BF3400", invoice_date: "2026-10-05",
      total_paise: toPaise("23600.00"), consumption: [{ po_number: "PO-1003", line_no: 1, base_qty: "10", amount_paise: toPaise("20000.00") }] });
    const r = await evalDirect(e, { priorRuns: [counterpart, other] });
    expect(codes(r)).toEqual(["POSSIBLE_DOUBLE_BILLING"]); // 15 + 10 = 25 fits once the counterpart is excluded
  });
  it("D4: different number, same vendor, date and total -> POSSIBLE_DUPLICATE", async () => {
    const r = await evalDirect(extractionOf("S1"), { priorRuns: [prior({ run_id: "run-z", state: "CLEARED", vendor_id: "V01", chain_key: "V01|FP2026999", invoice_date: "2026-10-12", total_paise: toPaise("18880.00") })] });
    expect(codes(r)).toContain("POSSIBLE_DUPLICATE");
  });
  it("normalisation: FP/2026/418 is in the same chain as FP-2026-0418", async () => {
    expect((await evalDirect(extractionOf("S5"))).chain_key).toBe(S1_CHAIN);
  });
});

describe("P1-P2 PO match", () => {
  it("PO printed as 7731 matches PO-7731", async () => {
    expect((await evalDirect(extractionOf("S3"))).po_number).toBe("PO-7731");
  });
  it("PO_AMBIGUOUS when two open POs fit every line (never guess)", async () => {
    const ref = structuredClone(reference);
    const p4 = ref.purchaseOrders.find((p) => p.po_number === "PO-1004")!;
    ref.purchaseOrders.push({ ...structuredClone(p4), po_number: "PO-1010", lines: p4.lines.map((l) => ({ ...l, po_number: "PO-1010" })) });
    const r = await evalDirect(extractionOf("S7"), { reference: ref });
    expect(codes(r)).toEqual(["PO_AMBIGUOUS"]);
  });
  it("PO of another vendor -> PO_VENDOR_MISMATCH", async () => {
    const e = extractionOf("S1");
    e.po_reference = "PO-1002";
    expect(codes(await evalDirect(e))).toContain("PO_VENDOR_MISMATCH");
  });
  it("unknown PO -> PO_NOT_FOUND", async () => {
    const e = extractionOf("S1");
    e.po_reference = "PO-9999";
    expect(codes(await evalDirect(e))).toContain("PO_NOT_FOUND");
  });
});

describe("M1-M7 lines (A4 order, A5 codes)", () => {
  it("X3: the charge line is never mapped, so no LINE_UNMAPPED", async () => {
    expect(codes(await evalDirect(extractionOf("X3")))).toEqual(["UNAPPROVED_CHARGE"]);
  });
  it("M7: a delivery line within a PO charge line (+2%) is accepted and the invoice clears", async () => {
    const ref = structuredClone(reference);
    const po = ref.purchaseOrders.find((p) => p.po_number === "PO-1006")!;
    po.lines.push({ po_number: "PO-1006", line_no: 3, item_code: null, line_kind: "charge", description: "Delivery charges", uom: "job", qty_ordered: "1", unit_price_pretax: "500.00", gst_rate: "0.18", line_amount_pretax: toPaise("500.00") });
    po.subtotal_pretax += toPaise("500.00");
    expect((await evalDirect(extractionOf("X3"), { reference: ref })).outcome).toBe("CLEARED");
    const e = extractionOf("X3");
    e.lines[2].unit_price = "520.00";
    e.lines[2].amount = "520.00";
    Object.assign(e, { subtotal: "9820.00", tax_total: "1767.60", cgst: "883.80", sgst: "883.80", total: "11587.60" });
    expect(codes(await evalDirect(e, { reference: ref }))).toEqual(["UNAPPROVED_CHARGE"]); // +4% over the PO charge
  });
  it("F6 at engine level: AI proposal with pack size 25 vs catalog 50 -> AI_PROPOSAL_REJECTED + UOM_UNSUPPORTED", async () => {
    const r = await evalDirect(extractionOf("S14"), { proposer: { label: "MOCK wrong pack", propose: async () => ({ proposed_po_line: 1, pack_size_read: 25, justification: "pack of 25" }) } });
    expect(codes(r)).toEqual(["AI_PROPOSAL_REJECTED", "UOM_UNSUPPORTED"]);
  });
  it("M4: two invoice lines on one PO line -> LINE_UNMAPPED naming the earlier line", async () => {
    const e = extractionOf("S1");
    e.lines[1].description = "Food container 500 ml (round, PP)";
    const r = await evalDirect(e);
    const f = r.blocking.find((x) => x.code === "LINE_UNMAPPED")!;
    expect(f.evidence.earlier_invoice_line).toBe(1);
  });
  it("T4: GST rate differs from the PO -> TAX_RATE_MISMATCH", async () => {
    const e = extractionOf("S4");
    e.lines[0].gst_rate = "0.05";
    expect(codes(await evalDirect(e))).toContain("TAX_RATE_MISMATCH");
  });
});

describe("C1-C5 compare", () => {
  it("C1 boundary: +2.00% within, +2.01% over (S11 BAG-M 3.06 / 3.0603)", async () => {
    const e = extractionOf("S11");
    e.lines[0].unit_price = "3.06";
    e.lines[0].amount = "6120.00";
    Object.assign(e, { subtotal: "6120.00", tax_total: "1101.60", cgst: "550.80", sgst: "550.80", total: "7221.60" });
    expect(codes(await evalDirect(e))).toEqual([]);
    e.lines[0].unit_price = "3.0603";
    e.lines[0].amount = "6120.60";
    Object.assign(e, { subtotal: "6120.60", tax_total: "1101.71", cgst: "550.85", sgst: "550.86", total: "7222.31" });
    expect(codes(await evalDirect(e))).toContain("PRICE_OVER_TOLERANCE");
  });
  it("C1 below: more than 2% under the PO -> info PRICE_BELOW_PO, still CLEARED", async () => {
    const e = extractionOf("S11");
    e.lines[0].unit_price = "2.90";
    e.lines[0].amount = "5800.00";
    Object.assign(e, { subtotal: "5800.00", tax_total: "1044.00", cgst: "522.00", sgst: "522.00", total: "6844.00" });
    const r = await evalDirect(e);
    expect(r.outcome).toBe("CLEARED");
    expect(infos(r)).toContain("PRICE_BELOW_PO");
  });
  it("C3: S3 at exactly the cap (10,200 = 10,000 x 1.02) does not add PO_AMOUNT_EXCEEDED", async () => {
    expect(codes(await evalDirect(extractionOf("S3")))).toEqual(["PRICE_OVER_TOLERANCE"]);
  });
  it("C5: total above the approval limit -> APPROVAL_LIMIT_EXCEEDED", async () => {
    const ref = structuredClone(reference);
    ref.settings.approval_limit_inr = 10000;
    expect(codes(await evalDirect(extractionOf("S1"), { reference: ref }))).toEqual(["APPROVAL_LIMIT_EXCEEDED"]);
  });
  it("settings drive the tolerance: at 1%, S11 (+1.5%) holds", async () => {
    const ref = structuredClone(reference);
    ref.settings.price_tolerance_pct = 1;
    expect(codes(await evalDirect(extractionOf("S11"), { reference: ref }))).toContain("PRICE_OVER_TOLERANCE");
  });
});

describe("decide keeps the correction info on every exit path", () => {
  it("a token-linked correction whose PO is not found still carries CORRECTION_CANDIDATE_OF", async () => {
    const e = extractionOf("S4");
    e.po_reference = "PO-9999";
    const r = await evalDirect(e, {
      document: { reply_token: "R-T0003" },
      tokens: new Map([["R-T0003", "run-s3"]]),
      priorRuns: [prior({ run_id: "run-s3", state: "AWAITING_VENDOR", vendor_id: "V03", chain_key: "V03|INV552", invoice_date: "2026-10-16", total_paise: toPaise("10200.00") })],
    });
    expect(codes(r)).toEqual(["PO_NOT_FOUND"]);
    expect(infos(r)).toContain("CORRECTION_CANDIDATE_OF");
    expect(r.correction?.kind).toBe("linked");
  });
});
