import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Extraction } from "@/domain/extraction-schema";
import { ingest, receiveUnreadable, type ExtractionAttempt, type Extractor, type ExtractorInput, type PipelineDeps } from "@/domain/runs/pipeline";
import { availableActions } from "@/domain/runs/queries";
import { approve, exportApproved, overrideApprove, processAsInvoice, requestCorrection } from "@/domain/runs/review";
import { readTextLayer } from "@/server/pdf-text";
import { extractionOf, textFrom } from "./support/direct";
import { AnswerKeyExtractor, called, deliver, makeDeps, reference } from "./support/harness";

// Audit 23 Oct (A01, A06, B08): a person's override must not open a path around the PO caps or the duplicate rules.
// MOCK reader (fixture extractions); the pipeline, rule engine, review actions and store are the real code.

const DIVYA = { actor: "Divya (AP)" };

class Fixture implements Extractor {
  readonly label = "MOCK fixture";
  private fallback = new AnswerKeyExtractor(reference);
  constructor(private docs: Map<string, Extraction | ExtractionAttempt>) {}
  async extract(i: ExtractorInput): Promise<ExtractionAttempt> {
    const d = this.docs.get(i.filename);
    if (!d) return this.fallback.extract(i);
    if ("status" in d) return d;
    return { status: "ok", extraction: structuredClone(d), attempts: 1, label: this.label };
  }
}

function setup(opts: { proposer?: PipelineDeps["proposer"] } = {}) {
  const docs = new Map<string, Extraction | ExtractionAttempt>();
  const deps: PipelineDeps = { ...makeDeps("proposer" in opts ? { proposer: opts.proposer } : {}), extractor: new Fixture(docs) };
  const send = (name: string, e: Extraction | ExtractionAttempt, o: { token?: string; text?: string; sha256?: string } = {}) => {
    docs.set(name, e);
    const ex = "status" in e ? null : e;
    return ingest(deps, {
      source: "email", sender_email: (ex && deps.reference.vendors.find((v) => v.gstin === ex.vendor_gstin)?.registered_senders[0]) || "billing@freshpack.example",
      uploader_display_name: null, provider_email_id: `p-${name}`, attachment_id: "a", filename: name, content_type: "application/pdf",
      bytes: new Uint8Array([1]), ...(o.sha256 ? { sha256: o.sha256 } : {}), subject: "Invoice", reply_token: o.token ?? null,
      text_layer: o.text ?? (ex ? textFrom(ex) : "x".repeat(60)), has_text_layer: true,
    });
  };
  const get = (id: string) => deps.store.read((s) => s.runs.get(id)!);
  return { deps, send, get };
}

/** A FreshPack invoice for the whole of PO-1009 (2,000 containers at 6.50). */
function fullPo1009(number: string, date: string): Extraction {
  const e = extractionOf("S1");
  Object.assign(e, { invoice_number: number, invoice_date: date, po_reference: "PO-1009", lines: [e.lines[0]], subtotal: "13000.00", tax_total: "2340.00", cgst: "1170.00", sgst: "1170.00", total: "15340.00" });
  return e;
}

describe("an override counts against the PO (spec v1.4 C4b, audit A01)", () => {
  it("S14 held LINE_UNMAPPED and approved by override uses up PO-1009, so a second full invoice on it is held", async () => {
    const { deps, send, get } = setup({ proposer: null });
    const s14 = await send("s14.pdf", extractionOf("S14"));
    expect(s14.blocking_codes).toEqual(["LINE_UNMAPPED"]);
    const ov = await overrideApprove(deps, s14.run_id, { ...DIVYA, note: "Takeaway box is the 500 ml container; confirmed with stores" });
    expect(ov.ok).toBe(true);
    expect((await get(s14.run_id)).consumption.reduce((a, c) => a + c.amount_paise, 0n)).toBe(1_300_000n);
    const second = await send("fp450.pdf", fullPo1009("FP-2026-0450", "2026-10-21"));
    expect(second.state).toBe("ON_HOLD");
    expect(second.blocking_codes).toContain("PO_AMOUNT_EXCEEDED");
  });

  it("no PO was found: the override must name one of the vendor's open POs, and it is then counted (S6a with a typo PO)", async () => {
    const { deps, send, get } = setup();
    const a = extractionOf("S6a");
    a.po_reference = "PO-1030";
    const first = await send("6a-typo.pdf", a);
    expect(first.blocking_codes).toEqual(["PO_NOT_FOUND"]);

    const choices = availableActions(first, await deps.store.read((s) => s), deps.reference).find((x) => x.action === "override_approve")!.po_choices;
    expect(choices).toContain("PO-1003");

    const without = await overrideApprove(deps, first.run_id, { ...DIVYA, note: "typo, it is PO-1003" });
    expect(without).toMatchObject({ ok: false, code: "NEEDS_PO" });
    const wrong = await overrideApprove(deps, first.run_id, { ...DIVYA, note: "typo", poNumber: "PO-1001" });
    expect(wrong).toMatchObject({ ok: false, code: "INVALID_TRANSITION_BLOCKED" });

    const ok = await overrideApprove(deps, first.run_id, { ...DIVYA, note: "typo, it is PO-1003", poNumber: "PO-1003" });
    expect(ok.ok).toBe(true);
    const approved = await get(first.run_id);
    expect(approved.po_number).toBe("PO-1003");
    expect(approved.consumption.some((c) => c.po_number === "PO-1003" && c.line_no > 0)).toBe(true);

    const b = extractionOf("S6a");
    Object.assign(b, { invoice_number: "BF-3399", invoice_date: "2026-10-11" });
    const second = await send("6a-b.pdf", b);
    expect(second.state).toBe("ON_HOLD");
    expect(second.blocking_codes).toEqual(expect.arrayContaining(["QTY_EXCEEDS_PO"]));
  });

  it("an unknown vendor has no POs to choose from, so its override needs none (S8)", async () => {
    const deps = makeDeps();
    const s8 = await deliver(deps, "S8", {});
    const r = await overrideApprove(deps, s8.run_id, { ...DIVYA, note: "One-off supplier, verified by phone", ...called() });
    expect(r.ok).toBe(true);
  });

  it("an ordinary held invoice (S3, price) is still approved by override as before", async () => {
    const deps = makeDeps();
    const s3 = await deliver(deps, "S3", {});
    expect((await overrideApprove(deps, s3.run_id, { ...DIVYA, note: "Price increase agreed by phone" })).ok).toBe(true);
  });
});

describe("no second payment for the same invoice through an override (spec v1.4 P9b, audit A06)", () => {
  it("an invoice whose reading failed has no total: it cannot be approved, so its clean twin is the only one exported", async () => {
    const docs = new Map<string, Extraction | ExtractionAttempt>();
    const deps: PipelineDeps = { ...makeDeps(), extractor: new Fixture(docs) };
    const pdf = new Uint8Array(readFileSync("zamp-ps1-test-data-v2.1/test-data/invoices/S01_FreshPack_FP-2026-0418.pdf"));
    const text = await readTextLayer(pdf, "application/pdf");
    docs.set("first.pdf", { status: "schema_invalid", errors: ["total: expected string"], attempts: 2, label: "MOCK" });
    const base = {
      source: "email" as const, sender_email: "billing@freshpack.example", uploader_display_name: null, attachment_id: "a1", content_type: "application/pdf",
      bytes: pdf, subject: "Invoice FP-2026-0418", reply_token: null, text_layer: text.text, has_text_layer: text.has_text_layer,
    };
    const a = await ingest(deps, { ...base, provider_email_id: "e1", filename: "first.pdf" });
    const b = await ingest(deps, { ...base, provider_email_id: "e2", filename: "S01_FreshPack_FP-2026-0418.pdf" });
    expect(a.blocking_codes).toEqual(["EXTRACTION_FAILED"]);
    expect((await approve(deps, [b.run_id], DIVYA)).ok).toBe(true);
    const ovA = await overrideApprove(deps, a.run_id, { ...DIVYA, note: "checked the PDF, looks fine" });
    expect(ovA).toMatchObject({ ok: false, code: "INVALID_TRANSITION_BLOCKED" });
    if (!ovA.ok) expect(ovA.reason).toMatch(/total was never read/);
    expect(availableActions(a, { runs: new Map() }).map((x) => x.action)).not.toContain("override_approve");
    const x = await exportApproved(deps, { actor: "Ravi (Finance)" });
    expect(x.ok && x.value.record.run_ids).toEqual([b.run_id]);
  });

  it("the same file approved once cannot be approved again by override", async () => {
    const { deps, send } = setup();
    const e = extractionOf("S8");
    const first = await send("one.pdf", e, { sha256: "same-file" });
    const twin = await send("two.pdf", { ...e, invoice_number: "QS-55-B" }, { sha256: "same-file" });
    expect((await overrideApprove(deps, first.run_id, { ...DIVYA, note: "new supplier, verified", ...called() })).ok).toBe(true);
    const again = await overrideApprove(deps, twin.run_id, { ...DIVYA, note: "new supplier, verified", ...called() });
    expect(again).toMatchObject({ ok: false, code: "INVALID_TRANSITION_BLOCKED" });
    if (!again.ok) expect(again.reason).toMatch(/^POSSIBLE_DOUBLE_BILLING: .*same file/);
  });

  it("an unknown vendor's invoice sent twice: only one override succeeds (same number and vendor name)", async () => {
    const deps = makeDeps();
    const a = await deliver(deps, "S8", {});
    const b = await deliver(deps, "S8", {}, { emailOverride: (_t, e) => ({ ...e, provider_email_id: e.provider_email_id + "-resent" }) });
    expect((await overrideApprove(deps, a.run_id, { ...DIVYA, note: "new supplier, onboarding pending", ...called() })).ok).toBe(true);
    const ob = await overrideApprove(deps, b.run_id, { ...DIVYA, note: "new supplier, onboarding pending", ...called() });
    expect(ob).toMatchObject({ ok: false, code: "INVALID_TRANSITION_BLOCKED" });
    if (!ob.ok) expect(ob.reason).toMatch(/^POSSIBLE_DOUBLE_BILLING: .*QS-55/);
    const x = await exportApproved(deps, DIVYA);
    expect(x.ok && x.value.record.run_ids).toEqual([a.run_id]);
  });

  it("a credit note cannot be approved for the payment list (G3)", async () => {
    const { deps, send } = setup();
    const e = extractionOf("S1");
    Object.assign(e, { doc_type: "credit_note", document_title: "CREDIT NOTE", number_label: "Credit Note No." });
    const cn = await send("cn.pdf", e);
    expect(cn.blocking_codes).toContain("CREDIT_NOTE_UNSUPPORTED");
    expect(availableActions(cn, { runs: new Map() }).map((x) => x.action)).not.toContain("override_approve");
    const r = await overrideApprove(deps, cn.run_id, { ...DIVYA, note: "ok" });
    expect(r).toMatchObject({ ok: false, code: "INVALID_TRANSITION_BLOCKED" });
    expect((await exportApproved(deps, DIVYA)).ok).toBe(false);
  });

  it("a correction requested on an unreadable invoice: after the vendor's clean reply, the original cannot also be approved", async () => {
    const { deps, send, get } = setup();
    const text = (await readTextLayer(new Uint8Array(readFileSync("zamp-ps1-test-data-v2.1/test-data/invoices/S01_FreshPack_FP-2026-0418.pdf")), "application/pdf")).text;
    const orig = await send("orig.pdf", { status: "schema_invalid", errors: ["lines: required"], attempts: 2, label: "MOCK" }, { text });
    const tok = await requestCorrection(deps, orig.run_id, DIVYA);
    const reply = await send("reply.pdf", extractionOf("S1"), { token: tok.ok ? tok.value.token : "", text });
    expect(reply.state).toBe("CLEARED");
    expect((await get(orig.run_id)).state).toBe("AWAITING_VENDOR");
    const ov = await overrideApprove(deps, orig.run_id, { ...DIVYA, note: "approving the original too" });
    expect(ov.ok).toBe(false);
  });
});

describe("process as invoice needs the stored file (audit B08)", () => {
  it("a skipped unsupported file has no document to read: refused, and the run stays skipped", async () => {
    const deps = makeDeps();
    const run = await receiveUnreadable(deps, {
      source: "email", sender_email: "billing@freshpack.example", uploader_display_name: null, provider_email_id: "p9", attachment_id: "a9",
      filename: "invoice.docx", content_type: "application/msword", size_bytes: 1000, subject: "s", reply_token: null,
    }, "UNSUPPORTED_FILE", "type not supported");
    const r = await processAsInvoice(deps, run.run_id, { ...DIVYA, note: "it is an invoice" });
    expect(r).toMatchObject({ ok: false, code: "INVALID_TRANSITION_BLOCKED" });
    expect((await deps.store.read((s) => s.runs.get(run.run_id)!)).state).toBe("SKIPPED");
  });
});

describe("correction requests only for what the vendor can fix (audit U03)", () => {
  it("S2, bank account changed: no correction email is offered or accepted; the reviewer verifies by phone", async () => {
    const deps = makeDeps();
    const s2 = await deliver(deps, "S2", {});
    expect(s2.blocking_codes).toEqual(["BANK_DETAILS_CHANGED"]);
    expect(availableActions(s2, { runs: new Map() }).map((a) => a.action)).not.toContain("request_correction");
    const r = await requestCorrection(deps, s2.run_id, { ...DIVYA, channel: "marked sent manually" });
    expect(r).toMatchObject({ ok: false, code: "INVALID_TRANSITION_BLOCKED" });
    expect((await deps.store.read((s) => s.runs.get(s2.run_id)!)).state).toBe("ON_HOLD");
  });

  it("S3, price over the PO: a correction request is offered and works as before", async () => {
    const deps = makeDeps();
    const s3 = await deliver(deps, "S3", {});
    expect(availableActions(s3, { runs: new Map() }).map((a) => a.action)).toContain("request_correction");
    expect((await requestCorrection(deps, s3.run_id, { ...DIVYA, channel: "marked sent manually" })).ok).toBe(true);
  });
});
