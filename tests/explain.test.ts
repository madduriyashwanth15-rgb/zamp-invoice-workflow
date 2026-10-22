import { beforeAll, describe, expect, it } from "vitest";
import type { Extraction } from "@/domain/extraction-schema";
import { ingest, receiveUnreadable, type ExtractionAttempt, type Extractor, type ExtractorInput, type PipelineDeps } from "@/domain/runs/pipeline";
import { manualHold, overrideApprove, requestCorrection } from "@/domain/runs/review";
import type { RunRecord } from "@/domain/runs/types";
import { unitInr } from "@/server/explain";
import { correctionDraft, detail, type RunDetail } from "@/server/views";
import { extractionOf, textFrom } from "./support/direct";
import { AnswerKeyProposer, deliver, makeDeps, runGolden, type GoldenEntry } from "./support/harness";

// Audit U01, U03-U05, U12: the review screen states the figures behind each hold, the correction email carries only
// what the vendor can fix, the lead button is an offered action, and MOCK runs never claim AI work.
// MOCK reader (answer key) throughout; the pipeline, engine, views and explanations are the real code.

const DIVYA = { actor: "Divya (AP)" };

async function view(deps: Pick<PipelineDeps, "store" | "reference">, run: RunRecord): Promise<RunDetail> {
  const state = await deps.store.read((s) => ({ runs: s.runs, documents: s.documents, tokens: s.tokens }));
  return detail(run, state, await deps.store.logs(run.run_id), deps.reference);
}

const RULE_TAG = /\((?:[A-Z]\d|v1\.\d)[^)]*\)/; // "(C1)", "(K4b)", "(M3, v1.4)"
const BROKEN = /undefined|null|NaN|\[object|an amount not read|a price not read/;

describe("every held golden scenario explains itself in plain words", () => {
  let golden: GoldenEntry[];
  let held: { e: GoldenEntry; d: RunDetail }[];
  beforeAll(async () => {
    golden = await runGolden();
    held = [];
    for (const e of golden.filter((g) => g.run.state === "ON_HOLD")) held.push({ e, d: await view({ store: e.store, reference: makeDeps().reference }, e.run) });
  });

  it("each hold code is covered by an issue whose sentence has figures, no rule tags and no blanks", () => {
    expect(held.map((h) => h.e.test.test_id).sort()).toEqual(["S10", "S12", "S2", "S3", "S6b", "S7", "S8", "X1", "X2", "X3"]);
    for (const { e, d } of held) {
      const covered = new Set(d.issues.flatMap((i) => i.codes));
      for (const c of e.run.blocking_codes) expect(covered.has(c), `${e.test.test_id} ${c}`).toBe(true);
      for (const i of d.issues) {
        expect(i.explain, `${e.test.test_id} ${i.codes[0]}`).not.toMatch(RULE_TAG);
        expect(i.explain, `${e.test.test_id} ${i.codes[0]}`).not.toMatch(BROKEN);
        expect(i.next, `${e.test.test_id} ${i.codes[0]} has advice while on hold`).toBeTruthy();
      }
    }
  });

  it("the correction email never carries rule codes, rule tags, or our own checks", () => {
    for (const { e, d } of held) {
      if (!d.correction_draft) continue;
      expect(d.correction_draft.body, e.test.test_id).not.toMatch(RULE_TAG);
      expect(d.correction_draft.body, e.test.test_id).not.toMatch(/\b[A-Z]{3,}_[A-Z_]+\b/); // PRICE_OVER_TOLERANCE etc.
      expect(d.correction_draft.body, e.test.test_id).not.toMatch(BROKEN);
      expect(d.correction_draft.body, e.test.test_id).not.toMatch(/bank|sender|DMARC|\bAI\b/i);
    }
  });

  it("S3 (price over): ₹42.00 against ₹40.00 on the PO, 5% over 2% tolerance, in the banner, the table and the email", () => {
    const { d } = held.find((h) => h.e.test.test_id === "S3")!;
    const price = d.issues.find((i) => i.codes[0] === "PRICE_OVER_TOLERANCE")!;
    expect(price.explain).toMatch(/₹42\.00 per .* against ₹40\.00 on PO-\d+ line \d/);
    expect(price.explain).toMatch(/5% more; the tolerance is 2%/);
    expect(price.explain).toMatch(/that is ₹[\d,]+\.\d\d above the PO price/);
    const row = d.po_table!.rows.find((r) => r.flags.includes("Price over"))!;
    expect(row.price_diff).toBe("+5%");
    expect(row.invoice_price).toMatch(/^₹42\.00 \//);
    expect(row.po_price).toMatch(/^₹40\.00 \//);
    expect(d.po_table!.rows.filter((r) => r.flags.length === 0).every((r) => r.ok_text === "Matches the PO")).toBe(true);
    expect(d.correction_draft!.body).toMatch(/works out to ₹42\.00 per .* before GST; purchase order PO-\d+ agreed ₹40\.00/);
    expect(d.recommended?.action).toBe("request_correction");
  });

  it("S2 (bank account changed): no correction email, no lead button, and the advice is a call to the master number", () => {
    const { d } = held.find((h) => h.e.test.test_id === "S2")!;
    expect(d.correction_draft).toBeNull();
    expect(d.actions.map((a) => a.action)).not.toContain("request_correction");
    expect(d.recommended).toBeNull();
    const bank = d.issues.find((i) => i.codes[0] === "BANK_DETAILS_CHANGED")!;
    expect(bank.explain).toMatch(/account ending \d{4}; the vendor master has the account ending \d{4}/);
    expect(bank.next).toMatch(/^Call .+ on \+?[\d -]+ \(vendor master\)/);
    expect(bank.next).not.toMatch(/ask the vendor/i);
  });

  it("S6b (over the PO): quantities and amounts named, with what was billed before", () => {
    const { d } = held.find((h) => h.e.test.test_id === "S6b")!;
    expect(d.issues.find((i) => i.codes[0] === "QTY_EXCEEDS_PO")!.explain).toMatch(/\d+ \S+ billed now and \d+ already billed, against \d+ ordered on PO-\d+ line \d/);
    expect(d.issues.find((i) => i.codes[0] === "PO_AMOUNT_EXCEEDED")!.explain).toMatch(/₹[\d,]+\.\d\d on this invoice plus ₹[\d,]+\.\d\d already billed comes to ₹[\d,]+\.\d\d before GST, above the ₹[\d,]+\.\d\d allowed/);
  });

  it("S10 (arithmetic): the computed and printed figures", () => {
    const { d } = held.find((h) => h.e.test.test_id === "S10")!;
    expect(d.issues[0].explain).toMatch(/is ₹[\d,]+\.\d\d, but the .* printed is ₹[\d,]+\.\d\d/);
  });

  it("S8 (unknown vendor, unverified sender): no lead button; the vendor sentence names the printed name", () => {
    const { d } = held.find((h) => h.e.test.test_id === "S8")!;
    expect(d.recommended).toBeNull();
    expect(d.issues[0].codes[0]).toBe("VENDOR_UNKNOWN");
    expect(d.issues[0].explain).toMatch(/^".+" .*is not in the vendor master/);
  });

  it("X2 (correction not linked): confirm the link is the lead button", () => {
    const { d } = held.find((h) => h.e.test.test_id === "X2")!;
    expect(d.recommended?.action).toBe("confirm_link");
  });

  it("S12 (lump sum) and S7 (scan): the reviewer's own check comes first, so no correction is pushed", () => {
    for (const id of ["S12", "S7"]) expect(held.find((h) => h.e.test.test_id === id)!.d.recommended, id).toBeNull();
  });

  it("a cleared invoice leads with approve; nothing is advised outside ON_HOLD", async () => {
    const s1 = golden.find((g) => g.test.test_id === "S1")!;
    const d = await view({ store: s1.store, reference: makeDeps().reference }, s1.run);
    expect(d.recommended?.action).toBe("approve");
    expect(d.issues).toEqual([]);
  });
});

describe("wording slips (U12)", () => {
  it("a MOCK run never says the AI read it or that a model was called", async () => {
    const deps = makeDeps();
    const d = await view(deps, await deliver(deps, "S9", {}));
    const notes = d.stages.flatMap((s) => s.notes.map((n) => n.text));
    expect(notes.join("\n")).not.toMatch(/The AI|provider call|call to the model/);
    expect(notes).toContain("Values from the MOCK answer key for this test file; no AI was called");
    expect(notes.some((t) => /^The MOCK reading read it as a quotation/.test(t))).toBe(true);
  });

  it("a skipped file says why it was skipped: not an invoice, unsupported file, or no attachment", async () => {
    const deps = makeDeps();
    const s9 = await view(deps, await deliver(deps, "S9", {}));
    expect(s9.stages.at(-1)!.notes.map((n) => n.text)).toContain("Not an invoice, so there is nothing to approve.");
    const bad = await receiveUnreadable(deps, {
      source: "upload", sender_email: null, uploader_display_name: "Divya (AP)", provider_email_id: null, attachment_id: null, subject: null, reply_token: null,
      filename: "notes.docx", content_type: "application/msword", size_bytes: 1200,
    }, "UNSUPPORTED_FILE", "type application/msword is not PDF, PNG or JPEG");
    const v = await view(deps, bad);
    expect(v.stages.at(-1)!.notes.map((n) => n.text).join(" ")).toMatch(/file type or size is not supported/);
    expect(v.stages.at(-1)!.notes.map((n) => n.text).join(" ")).not.toMatch(/Not an invoice/);
  });

  it("after an exception approval the holds are still explained, but no advice is shown", async () => {
    const deps = makeDeps();
    const s3 = await deliver(deps, "S3", {});
    const r = await overrideApprove(deps, s3.run_id, { ...DIVYA, note: "Price rise agreed by phone" });
    expect(r.ok).toBe(true);
    const d = await view(deps, (await deps.store.read((s) => s.runs.get(s3.run_id)))!);
    expect(d.issues.length).toBeGreaterThan(0);
    expect(d.issues.every((i) => i.next === null)).toBe(true);
    expect(d.recommended).toBeNull();
  });
});

describe("manual hold and the email", () => {
  it("a reviewer's hold quotes their note, and the correction email carries it", async () => {
    const deps = makeDeps();
    const s1 = await deliver(deps, "S1", {});
    const h = await manualHold(deps, s1.run_id, { ...DIVYA, note: "Please confirm the delivery date on the invoice" });
    expect(h.ok).toBe(true);
    const d = await view(deps, (await deps.store.read((s) => s.runs.get(s1.run_id)))!);
    expect(d.issues[0]).toMatchObject({ codes: ["MANUAL_HOLD"], explain: 'Put on hold by a reviewer: "Please confirm the delivery date on the invoice".' });
    expect(d.correction_draft!.body).toContain("- Please confirm the delivery date on the invoice");
    const sent = await requestCorrection(deps, s1.run_id, { ...DIVYA, channel: "marked sent manually" });
    expect(sent.ok).toBe(true);
  });

  it("with no hold note available the email still has a reason, not a code title", async () => {
    const deps = makeDeps();
    const s1 = await deliver(deps, "S1", {});
    await manualHold(deps, s1.run_id, { ...DIVYA, note: "x" });
    const run = (await deps.store.read((s) => s.runs.get(s1.run_id)))!;
    expect(correctionDraft(run, "R-T00011ABC", deps.reference).body).toContain("- We need to check some details on it before it can go on our payment list.");
  });
});

describe("unit prices keep their precision", () => {
  it.each([
    ["40", "₹40.00"], ["42.0000", "₹42.00"], ["0.83333", "₹0.8333"], ["6.5", "₹6.50"], ["1234567.5", "₹12,34,567.50"], ["-2.125", "-₹2.125"],
  ])("%s -> %s", (v, out) => expect(unitInr(v)).toBe(out));
});

// ---- single rules, through the real pipeline with a scripted (MOCK) reading of each document

class Scripted implements Extractor {
  readonly label = "MOCK scripted reading";
  constructor(private docs: Map<string, Extraction | ExtractionAttempt>) {}
  async extract(i: ExtractorInput): Promise<ExtractionAttempt> {
    const d = this.docs.get(i.filename)!;
    return "status" in d ? d : { status: "ok", extraction: structuredClone(d), attempts: 1, label: this.label };
  }
}

function scripted(opts: { proposer?: PipelineDeps["proposer"] } = {}) {
  const docs = new Map<string, Extraction | ExtractionAttempt>();
  const deps: PipelineDeps = { ...makeDeps("proposer" in opts ? { proposer: opts.proposer } : {}), extractor: new Scripted(docs) };
  const send = async (name: string, e: Extraction | ExtractionAttempt, text?: string) => {
    docs.set(name, e);
    const ex = "status" in e ? null : e;
    const run = await ingest(deps, {
      source: "email", sender_email: (ex && deps.reference.vendors.find((v) => v.gstin === ex.vendor_gstin)?.registered_senders[0]) || "billing@freshpack.example",
      uploader_display_name: null, provider_email_id: `p-${name}`, attachment_id: "a", filename: name, content_type: "application/pdf",
      bytes: new Uint8Array([name.length]), subject: "Invoice", reply_token: null,
      text_layer: text ?? (ex ? textFrom(ex) : "x".repeat(60)), has_text_layer: true,
    });
    return view(deps, run);
  };
  return { deps, send };
}

describe("single rules explained", () => {
  it("K4b: an unread bank account is our check: figures and the master number, no email, no lead button", async () => {
    const { send } = scripted();
    const e = { ...extractionOf("S1"), bank_account_last4: null, bank_account_number: null };
    const d = await send("k4b.pdf", e, `${textFrom(e)}\nBank A/c No: 50200012340042 IFSC HDFC0001234`);
    expect(d.blocking.map((c) => c.code)).toEqual(["MISSING_REQUIRED_FIELD"]);
    expect(d.issues[0].explain).toMatch(/A bank account is printed \("A\/c"\), but it was not read, so it was not compared with the account on file \(ending \d{4}\)/);
    expect(d.issues[0].next).toMatch(/verify by phone using \+?[\d ]+/);
    expect(d.issues[0].vendor_fixable).toBe(false);
    expect(d.correction_draft).toBeNull();
    expect(d.recommended).toBeNull();
  });

  it("G1b: a quotation read as an invoice asks the vendor for the tax invoice", async () => {
    const { send } = scripted();
    const e = { ...extractionOf("S1"), document_title: "QUOTATION", number_label: "Quote No." };
    const d = await send("g1b.pdf", e);
    const c = d.issues.find((i) => i.codes[0] === "CLASSIFICATION_CONFLICT")!;
    expect(c.explain).toBe('It was read as an invoice, but the title or number label says "quotation", which is not a tax invoice.');
    expect(d.correction_draft!.body).toContain('- The document is marked "quotation". Please send the tax invoice.');
  });

  it("G2: our reader disagreeing with a printed invoice title is not the vendor's to fix", async () => {
    const { send } = scripted();
    const d = await send("g2.pdf", { ...extractionOf("S1"), doc_type: "quotation" });
    expect(d.blocking.map((c) => c.code)).toEqual(["CLASSIFICATION_CONFLICT"]);
    expect(d.issues[0].explain).toMatch(/^The MOCK reading read it as quotation, but its title "TAX INVOICE" says invoice\.$/);
    expect(d.correction_draft).toBeNull();
    expect(d.actions.map((a) => a.action)).not.toContain("request_correction");
  });

  it("an AI line match rejected for size is one issue naming both sizes; the email asks about the line, not the AI", async () => {
    const proposer = new AnswerKeyProposer(() => ({ proposed_po_line: 1, pack_size_read: null, justification: "scripted: PO line 1" }));
    const { send } = scripted({ proposer });
    const e = extractionOf("S1");
    e.lines = e.lines.map((l) => (l.line_no === 1 ? { ...l, description: "Food container 750 ml (round, PP)" } : l));
    const d = await send("m3b.pdf", e);
    const ai = d.issues.filter((i) => i.line_no === 1);
    expect(ai).toHaveLength(1);
    expect(ai[0].codes).toEqual(["AI_PROPOSAL_REJECTED", "LINE_UNMAPPED"]);
    expect(ai[0].explain).toMatch(/^The MOCK proposer matched line 1 "Food container 750 ml \(round, PP\)" to PO-\d+ line 1 "Food container 500 ml", but the code did not accept it: .*750 ml.*500 ml|500 ml.*750 ml/);
    expect(d.correction_draft!.body).toContain('- Line 1 "Food container 750 ml (round, PP)" is not an item on purchase order');
    expect(d.correction_draft!.body).not.toMatch(/\bAI\b|proposal/i);
    expect(d.po_table!.rows[0].flags).toEqual(["Proposed match rejected", "Not matched"]);
  });

  it("a printed PO that is not ours: named in the banner and in the email", async () => {
    const { send } = scripted();
    const d = await send("p1.pdf", { ...extractionOf("S1"), po_reference: "PO-9999" });
    expect(d.issues[0].explain).toBe("The PO printed, PO-9999, is not one of our purchase orders.");
    expect(d.correction_draft!.body).toContain("- The purchase order number on the invoice, PO-9999, does not match an order we placed with you.");
  });

  it("an answer that failed validation: explained without claiming AI, and the advice says the reply comes in as a new invoice", async () => {
    const { send } = scripted();
    const d = await send("bad.pdf", { status: "schema_invalid", errors: ["total: expected string"], attempts: 2, label: "MOCK scripted reading" });
    expect(d.issues[0].codes).toEqual(["EXTRACTION_FAILED"]);
    expect(d.issues[0].explain).not.toMatch(/\bAI\b|model/);
    expect(d.issues[0].next).toMatch(/read as a new invoice/);
    expect(d.recommended).toBeNull();
  });

  it("a credit note: no exception is offered, so none is advised", async () => {
    const { send } = scripted();
    const d = await send("cn.pdf", { ...extractionOf("S1"), doc_type: "credit_note", document_title: "CREDIT NOTE" });
    expect(d.actions.map((a) => a.action)).not.toContain("override_approve");
    for (const i of d.issues) expect(i.next ?? "").not.toMatch(/exception/);
  });
});
