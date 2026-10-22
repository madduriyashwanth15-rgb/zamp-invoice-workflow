import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Extraction } from "@/domain/extraction-schema";
import { failStuckRuns, ingest, receive, receiveUnreadable, type ExtractionAttempt, type Extractor, type ExtractorInput, type PipelineDeps } from "@/domain/runs/pipeline";
import { approve, confirmCorrectionLink, exportApproved, overrideApprove, reject, requestCorrection, retry, stopWaiting } from "@/domain/runs/review";
import { loadEmail, TEST_DATA_DIR } from "@/fixtures/load";
import { ingestEmail } from "@/server/email-intake";
import { withTaxTotal } from "@/server/extractor/gemini-extractor";
import { extractionOf, textFrom } from "./support/direct";
import { AnswerKeyExtractor, deliver, makeDeps, reference } from "./support/harness";

// Regression tests for the independent review of the overnight build (22 Oct). Each test reproduces a defect the
// reviewer demonstrated, and now asserts the fixed behaviour.

const DIVYA = { actor: "Divya (AP)" };

class Fixture implements Extractor {
  readonly label = "MOCK fixture extractor";
  private fallback = new AnswerKeyExtractor(reference);
  constructor(private docs: Map<string, Extraction>) {}
  async extract(input: ExtractorInput): Promise<ExtractionAttempt> {
    const s = this.docs.get(input.filename);
    return s ? { status: "ok", extraction: structuredClone(s), attempts: 1, label: this.label } : this.fallback.extract(input);
  }
}

function setup() {
  const docs = new Map<string, Extraction>();
  const deps: PipelineDeps = { ...makeDeps(), extractor: new Fixture(docs) };
  const get = (id: string) => deps.store.read((s) => s.runs.get(id)!);
  const send = (name: string, e: Extraction, o: { token?: string | null; authenticated?: boolean | null } = {}) => {
    docs.set(name, e);
    const v = deps.reference.vendors.find((x) => x.gstin === e.vendor_gstin || x.legal_name === e.vendor_name);
    return ingest(deps, {
      source: "email", sender_email: v?.registered_senders[0] ?? null, uploader_display_name: null, provider_email_id: `p-${name}`, attachment_id: "a-1",
      filename: name, content_type: "application/pdf", bytes: new Uint8Array([1]), subject: `Invoice ${e.invoice_number}`, reply_token: o.token ?? null,
      text_layer: textFrom(e), has_text_layer: true, sender_authenticated: o.authenticated ?? null,
    });
  };
  return { deps, get, send };
}

describe("A12: a reply token is valid only while its run is ON_HOLD or AWAITING_VENDOR", () => {
  it("S3 rejected after the request: a reply with its token no longer links and supersedes nothing", async () => {
    const { deps, get, send } = setup();
    const s3 = await send("s3.pdf", extractionOf("S3"));
    const tok = await requestCorrection(deps, s3.run_id, DIVYA);
    const token = tok.ok ? tok.value.token : "";
    const x2 = await send("x2.pdf", extractionOf("X2"));
    expect(x2.blocking_codes).toEqual(["CORRECTION_UNCONFIRMED"]);
    await reject(deps, s3.run_id, { ...DIVYA, note: "closed" });
    const fix = extractionOf("S4");
    fix.invoice_date = "2026-10-21";
    const reply = await send("fix.pdf", fix, { token });
    expect(reply.state).toBe("ON_HOLD");
    expect(reply.blocking_codes).toEqual(["CORRECTION_UNCONFIRMED"]);
    expect(reply.engine!.blocking[0].evidence.reason).toBe("token no longer valid: its invoice is REJECTED");
    expect((await get(x2.run_id)).state).toBe("ON_HOLD");
  });
});

describe("lump-sum lines count against the PO once approved", () => {
  it("S12 approved with an exception uses up its amount; an itemised invoice for the same work then holds", async () => {
    const { deps, get, send } = setup();
    const s12 = await send("s12.pdf", extractionOf("S12"));
    expect(s12.blocking_codes).toEqual(["BUNDLED_QUANTITY_UNVERIFIED"]);
    const ov = await overrideApprove(deps, s12.run_id, { ...DIVYA, note: "work completed, checked on site" });
    expect(ov.ok).toBe(true);
    expect((await get(s12.run_id)).consumption.map((c) => [c.line_no, c.amount_paise])).toEqual([[0, 900000n]]);
    const e = extractionOf("S12");
    e.invoice_number = "SKE-130";
    e.invoice_date = "2026-10-20";
    e.lines = [
      { line_no: 1, description: "Exhaust hood deep cleaning", hsn_sac: "9987", qty: "2", uom: "visit", unit_price: "3500.00", amount: "7000.00", gst_rate: "0.18" },
      { line_no: 2, description: "Duct cleaning", hsn_sac: "9987", qty: "1", uom: "job", unit_price: "2000.00", amount: "2000.00", gst_rate: "0.18" },
    ];
    const second = await send("ske130.pdf", e);
    expect(second.state).toBe("ON_HOLD");
    expect(second.blocking_codes).toContain("PO_AMOUNT_EXCEEDED");
  });
});

describe("rows 16 and 17 re-run C2/C3 like an override", () => {
  it("row 16 on X2 after the PO was used up by another invoice asks for a second confirmation", async () => {
    const { deps, get, send } = setup();
    await send("s3.pdf", extractionOf("S3"));
    const x2 = await send("x2.pdf", extractionOf("X2"));
    const other = extractionOf("S4");
    other.invoice_number = "INV-600";
    other.invoice_date = "2026-10-15";
    other.revision_marker = false;
    expect((await send("other.pdf", other)).state).toBe("CLEARED");
    const first = await confirmCorrectionLink(deps, x2.run_id, { ...DIVYA, note: "vendor confirmed by phone" });
    expect(!first.ok && first.code).toBe("NEEDS_CONFIRMATION");
    expect((await get(x2.run_id)).state).toBe("ON_HOLD");
    const second = await confirmCorrectionLink(deps, x2.run_id, { ...DIVYA, note: "vendor confirmed by phone", confirmFailingChecks: true });
    expect(second.ok && second.value.state).toBe("APPROVED");
  });

  it("row 16 is refused when no held invoice is left to replace", async () => {
    const { deps, send } = setup();
    const s3 = await send("s3.pdf", extractionOf("S3"));
    const x2 = await send("x2.pdf", extractionOf("X2"));
    await reject(deps, s3.run_id, { ...DIVYA, note: "closed" });
    const r = await confirmCorrectionLink(deps, x2.run_id, { ...DIVYA, note: "link" });
    expect(!r.ok && r.reason).toMatch(/No held invoice is left/);
  });
});

describe("dispute resolution keeps the block while any dispute is open", () => {
  it("rejecting one disputing run does not lift the block while another waits for the vendor", async () => {
    const { deps, get, send } = setup();
    const s1 = await send("s1.pdf", extractionOf("S1"));
    await approve(deps, [s1.run_id], DIVYA);
    const variant = (qty: string, amt: string, sub: string, tax: string, half: string, tot: string, date: string) => {
      const e = extractionOf("S1");
      e.invoice_date = date;
      e.lines[1].qty = qty;
      e.lines[1].amount = amt;
      Object.assign(e, { subtotal: sub, tax_total: tax, cgst: half, sgst: half, total: tot });
      return e;
    };
    const n1 = await send("n1.pdf", variant("900", "2700.00", "15700.00", "2826.00", "1413.00", "18526.00", "2026-10-13"));
    const n2 = await send("n2.pdf", variant("800", "2400.00", "15400.00", "2772.00", "1386.00", "18172.00", "2026-10-14"));
    expect([n1.blocking_codes, n2.blocking_codes]).toEqual([["POSSIBLE_DOUBLE_BILLING"], ["POSSIBLE_DOUBLE_BILLING"]]);
    await requestCorrection(deps, n1.run_id, DIVYA);
    await reject(deps, n2.run_id, { ...DIVYA, note: "sent by mistake" });
    expect((await get(s1.run_id)).export_blocked).toBe(true);
    const ex = await exportApproved(deps, DIVYA);
    expect(ex.ok).toBe(false);
    // Once the last open dispute ends, the block lifts.
    await stopWaiting(deps, n1.run_id, { ...DIVYA, note: "vendor did not reply" });
    await reject(deps, n1.run_id, { ...DIVYA, note: "duplicate" });
    expect((await get(s1.run_id)).export_blocked).toBe(false);
  });
});

describe("intake never strands a run", () => {
  it("a damaged second attachment is SKIPPED UNSUPPORTED_FILE and the first is still processed", async () => {
    const deps = makeDeps();
    const base = loadEmail("S1");
    const good = new Uint8Array(readFileSync(path.join(TEST_DATA_DIR, base.attachments[0].path)));
    const email = { ...base, attachments: [base.attachments[0], { ...base.attachments[0], filename: "broken.pdf" }] };
    const r = await ingestEmail(deps, email, async (i) => (i === 0 ? good : new TextEncoder().encode("%PDF-1.4 not really a pdf")), async () => {});
    await Promise.all(r.work.map((w) => w()));
    const runs = await deps.store.read((s) => r.run_ids.map((id) => s.runs.get(id)!));
    expect(runs.map((x) => [x.filename, x.state, x.primary_reason])).toEqual([
      ["S01_FreshPack_FP-2026-0418.pdf", "CLEARED", null],
      ["broken.pdf", "SKIPPED", "UNSUPPORTED_FILE"],
    ]);
    expect(runs[1].failure).toMatch(/could not be opened/);
  });

  it("a run recorded but never started is FAILED by the sweep (rows 1 and 3) and can be retried", async () => {
    let t = Date.UTC(2026, 9, 22, 9, 0, 0);
    const deps: PipelineDeps = { ...makeDeps(), now: () => new Date(t).toISOString() };
    const r = await receive(deps, {
      source: "upload", sender_email: null, uploader_display_name: "Divya (AP)", provider_email_id: null, attachment_id: null,
      filename: "S01_FreshPack_FP-2026-0418.pdf", content_type: "application/pdf", bytes: new Uint8Array([1]), subject: null, reply_token: null,
      text_layer: textFrom(extractionOf("S1")), has_text_layer: true,
    });
    t += 10 * 60_000;
    expect(await failStuckRuns(deps, 8 * 60_000)).toEqual([r.run_id]);
    const events = (await deps.store.logs(r.run_id)).events.filter((e) => e.type === "STATE_CHANGED").map((e) => e.transition);
    expect(events).toEqual([1, 3]);
    const again = await retry(deps, r.run_id, DIVYA);
    expect(again.ok && again.value.state).toBe("CLEARED");
  });

  it("retry is refused for a run with no stored file (attachment never fetched)", async () => {
    const deps = makeDeps();
    const run = await receiveUnreadable(deps, {
      source: "email", sender_email: "billing@freshpack.example", uploader_display_name: null, provider_email_id: "p1", attachment_id: "a1",
      filename: "x.pdf", content_type: "application/pdf", size_bytes: null, subject: "s", reply_token: null,
    }, "ATTACHMENT_FETCH_FAILED", "boom");
    const r = await retry(deps, run.run_id, DIVYA);
    expect(!r.ok && r.code).toBe("INVALID_TRANSITION_BLOCKED");
    expect((await deps.store.read((s) => s.runs.get(run.run_id)!)).state).toBe("FAILED");
  });
});

describe("sender authentication and tokens", () => {
  it("a reply that failed DMARC is SENDER_UNVERIFIED and does not link, even with a valid token", async () => {
    const { deps, get, send } = setup();
    const s3 = await send("s3.pdf", extractionOf("S3"));
    const tok = await requestCorrection(deps, s3.run_id, DIVYA);
    const reply = await send("s4.pdf", extractionOf("S4"), { token: tok.ok ? tok.value.token : null, authenticated: false });
    expect(reply.blocking_codes.sort()).toEqual(["CORRECTION_UNCONFIRMED", "SENDER_UNVERIFIED"]);
    expect((await get(s3.run_id)).state).toBe("ON_HOLD"); // row 12: the vendor's reply was held
  });

  it("tokens carry a suffix from the run id and change on every request", async () => {
    const deps = makeDeps();
    const s3 = await deliver(deps, "S3", {});
    const a = await requestCorrection(deps, s3.run_id, DIVYA);
    await stopWaiting(deps, s3.run_id, { ...DIVYA, note: "no reply" });
    const b = await requestCorrection(deps, s3.run_id, DIVYA);
    const [ta, tb] = [a.ok ? a.value.token : "", b.ok ? b.value.token : ""];
    expect(ta).toMatch(/^R-T\d{4}[0-9A-Z]{4}$/);
    expect(tb).toMatch(/^R-T\d{4}[0-9A-Z]{4}$/);
    expect(tb).not.toBe(ta);
    expect(await deps.store.read((s) => [s.tokens.get(ta), s.tokens.get(tb)])).toEqual([s3.run_id, s3.run_id]);
  });
});

describe("live run, 22 Oct: invoices that print only CGST and SGST (no tax total line)", () => {
  it("the printed components are still checked: a wrong CGST with no tax total is ARITHMETIC_MISMATCH", async () => {
    const { send } = setup();
    const e = extractionOf("S1");
    e.tax_total = null;
    const ok = await send("s1-no-total.pdf", structuredClone(e));
    expect(ok.state).toBe("CLEARED");
    const bad = structuredClone(e);
    bad.invoice_number = "FP-2026-0499";
    bad.cgst = "1540.00";
    const held = await send("s1-bad-cgst.pdf", bad);
    expect(held.blocking_codes).toContain("ARITHMETIC_MISMATCH");
  });

  it("the extractor fills a missing tax total by adding the printed components, and keeps a printed one", () => {
    const e = extractionOf("S14");
    expect(withTaxTotal({ ...e, tax_total: null }).tax_total).toBe("2340.00");
    expect(withTaxTotal({ ...e, tax_total: "2340.00", cgst: null, sgst: null }).tax_total).toBe("2340.00");
    expect(withTaxTotal({ ...e, tax_total: null, cgst: null, sgst: null, igst: null }).tax_total).toBeNull();
  });
});
