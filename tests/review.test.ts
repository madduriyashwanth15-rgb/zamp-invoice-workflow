import { describe, expect, it } from "vitest";
import type { Extraction } from "@/domain/extraction-schema";
import { ingest, type ExtractionAttempt, type Extractor, type ExtractorInput, type PipelineDeps } from "@/domain/runs/pipeline";
import {
  approve, approvalsOf, confirmCorrectionLink, eventsOf, exportApproved, manualHold, overrideApprove, processAsInvoice,
  reject, replaceApproved, requestCorrection, retry, stopWaiting,
} from "@/domain/runs/review";
import type { RunRecord } from "@/domain/runs/types";
import { AnswerKeyExtractor, deliver, makeDeps, reference } from "./support/harness";
import { extractionOf, textFrom } from "./support/direct";

// Test matrix T1-T17, F1, F5, F7 at the domain level (in-memory store; the Postgres store repeats T1, T2, T9, T16).

const DIVYA = { actor: "Divya (AP)" };

/** MOCK extractor: synthetic documents by file name, otherwise the answer key. */
class FixtureExtractor implements Extractor {
  readonly label = "MOCK fixture extractor";
  private fallback = new AnswerKeyExtractor(reference);
  constructor(private synthetic: Map<string, Extraction | ExtractionAttempt>, private gate?: Promise<void>) {}
  async extract(input: ExtractorInput): Promise<ExtractionAttempt> {
    if (this.gate) await this.gate;
    const s = this.synthetic.get(input.filename);
    if (!s) return this.fallback.extract(input);
    if ("status" in s) return s;
    return { status: "ok", extraction: structuredClone(s), attempts: 1, label: this.label };
  }
}

function setup(gate?: Promise<void>) {
  const synthetic = new Map<string, Extraction | ExtractionAttempt>();
  const deps: PipelineDeps = { ...makeDeps(), extractor: new FixtureExtractor(synthetic, gate) };
  const get = (id: string) => deps.store.read((s) => s.runs.get(id)!);
  /** A synthetic invoice whose text layer contains its own values (so V3 passes) arriving from the vendor's registered sender. */
  const send = (name: string, e: Extraction, o: { source?: "email" | "upload"; sender?: string | null; uploader?: string; providerId?: string } = {}) => {
    synthetic.set(name, e);
    const v = deps.reference.vendors.find((x) => x.gstin === e.vendor_gstin || x.legal_name === e.vendor_name);
    const source = o.source ?? "email";
    return ingest(deps, {
      source, sender_email: source === "email" ? (o.sender === undefined ? v?.registered_senders[0] ?? null : o.sender) : null,
      uploader_display_name: source === "upload" ? o.uploader ?? "Divya (AP)" : null,
      provider_email_id: source === "email" ? o.providerId ?? `p-${name}` : null, attachment_id: source === "email" ? "a-1" : null,
      filename: name, content_type: "application/pdf", bytes: new Uint8Array(), subject: `Invoice ${e.invoice_number}`, reply_token: null,
      text_layer: textFrom(e), has_text_layer: true,
    });
  };
  return { deps, synthetic, get, send };
}

/** S1 with different content (900 bags instead of 1,000), same invoice number. */
function s1Variant(): Extraction {
  const e = extractionOf("S1");
  e.invoice_date = "2026-10-13";
  e.lines[1].qty = "900";
  e.lines[1].amount = "2700.00";
  Object.assign(e, { subtotal: "15700.00", tax_total: "2826.00", cgst: "1413.00", sgst: "1413.00", total: "18526.00" });
  return e;
}

const blockedEvents = async (deps: PipelineDeps, id: string) => (await eventsOf(deps, id)).filter((e) => e.type === "INVALID_TRANSITION_BLOCKED");

describe("T1: transitions outside spec section 11 are refused and logged", () => {
  it("REJECTED -> APPROVED, SUPERSEDED -> anything, CLEARED -> REJECTED, exported APPROVED -> anything", async () => {
    const { deps, get, send } = setup();
    const s1 = await send("s1.pdf", extractionOf("S1"));
    const dup = await send("s1-reprint.pdf", extractionOf("S5"));
    expect(dup.state).toBe("REJECTED");
    const r1 = await overrideApprove(deps, dup.run_id, { ...DIVYA, note: "pay it" });
    expect(r1.ok).toBe(false);
    expect(await blockedEvents(deps, dup.run_id)).toHaveLength(1);
    const r2 = await reject(deps, s1.run_id, { ...DIVYA, note: "no" }); // CLEARED -> REJECTED is not a row
    expect(r2.ok).toBe(false);
    await approve(deps, [s1.run_id], DIVYA);
    await exportApproved(deps, DIVYA);
    expect((await get(s1.run_id)).exported).toBe(true);
    expect((await manualHold(deps, s1.run_id, { ...DIVYA, note: "wait" })).ok).toBe(false);
    expect((await get(s1.run_id)).state).toBe("APPROVED");
  });
  it("SUPERSEDED -> anything (S3 after S4 cleared with the token)", async () => {
    const deps = makeDeps();
    const s3 = await deliver(deps, "S3", {});
    const tok = await requestCorrection(deps, s3.run_id, DIVYA);
    expect(tok.ok).toBe(true);
    await deliver(deps, "S4", { S3: tok.ok ? tok.value.token : "" });
    const s3now = await deps.store.read((s) => s.runs.get(s3.run_id)!);
    expect(s3now.state).toBe("SUPERSEDED");
    for (const r of [await reject(deps, s3.run_id, { ...DIVYA, note: "x" }), await overrideApprove(deps, s3.run_id, { ...DIVYA, note: "x" }), await stopWaiting(deps, s3.run_id, { ...DIVYA, note: "x" })]) {
      expect(r.ok).toBe(false);
    }
    expect(await blockedEvents(deps, s3.run_id)).toHaveLength(3);
  });
});

describe("T2: note-required rows refuse an empty note", () => {
  it("rows 7, 9, 10, 13, 14, 16, 17 and 5", async () => {
    const { deps, send } = setup();
    const cleared = await send("a.pdf", extractionOf("S1"));
    expect((await manualHold(deps, cleared.run_id, { ...DIVYA, note: " " })).ok).toBe(false); // 7
    const held = await send("b.pdf", extractionOf("S10"));
    expect((await overrideApprove(deps, held.run_id, { ...DIVYA, note: "" })).ok).toBe(false); // 9
    expect((await reject(deps, held.run_id, { ...DIVYA, note: "" })).ok).toBe(false); // 10
    await requestCorrection(deps, held.run_id, DIVYA);
    expect((await stopWaiting(deps, held.run_id, { ...DIVYA, note: "" })).ok).toBe(false); // 13
    expect((await reject(deps, held.run_id, { ...DIVYA, note: "" })).ok).toBe(false); // 14
    const skipped = await send("q.pdf", extractionOf("S9"));
    expect((await processAsInvoice(deps, skipped.run_id, { ...DIVYA, note: "" })).ok).toBe(false); // 5
  });
});

describe("T3: override approval of S6b re-runs C2/C3 and needs a second confirmation", () => {
  it("first attempt asks for confirmation, second approves", async () => {
    const deps = makeDeps();
    await deliver(deps, "S6a", {});
    const s6b = await deliver(deps, "S6b", {});
    const first = await overrideApprove(deps, s6b.run_id, { ...DIVYA, note: "vendor confirmed extra delivery" });
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.code).toBe("NEEDS_CONFIRMATION");
      expect(String(first.details?.problems)).toMatch(/C2 PO-1003 line 1: 27/);
    }
    const second = await overrideApprove(deps, s6b.run_id, { ...DIVYA, note: "vendor confirmed extra delivery", confirmFailingChecks: true });
    expect(second.ok && second.value.state).toBe("APPROVED");
    expect((await approvalsOf(deps, s6b.run_id))[0]).toMatchObject({ mode: "override", approver_display_name: "Divya (AP)" });
  });
});

describe("T4a-d: disputes against cleared, approved and exported invoices", () => {
  it("T4a: against a CLEARED run: new ON_HOLD POSSIBLE_DOUBLE_BILLING; original ON_HOLD RELATED_INVOICE_DISPUTE; consumption released", async () => {
    const { deps, get, send } = setup();
    const s1 = await send("s1.pdf", extractionOf("S1"));
    const v = await send("s1-v.pdf", s1Variant());
    expect(v.state).toBe("ON_HOLD");
    expect(v.blocking_codes).toEqual(["POSSIBLE_DOUBLE_BILLING"]);
    expect((await get(s1.run_id)).state).toBe("ON_HOLD");
    expect((await get(s1.run_id)).blocking_codes).toContain("RELATED_INVOICE_DISPUTE");
    expect((await exportApproved(deps, DIVYA)).ok).toBe(false); // nothing approved, nothing exportable
  });
  it("T4b + T4c: against an APPROVED run: original stays APPROVED but export-blocked; replacement supersedes it", async () => {
    const { deps, get, send } = setup();
    const s1 = await send("s1.pdf", extractionOf("S1"));
    await approve(deps, [s1.run_id], DIVYA);
    const v = await send("s1-v.pdf", s1Variant());
    expect(v.blocking_codes).toEqual(["POSSIBLE_DOUBLE_BILLING"]); // C2/C3 excluded the original (A8)
    expect(await get(s1.run_id)).toMatchObject({ state: "APPROVED", export_blocked: true, export_block_reason: "RELATED_INVOICE_DISPUTE" });
    expect((await exportApproved(deps, DIVYA)).ok).toBe(false); // export excludes it
    const rep = await replaceApproved(deps, v.run_id, { ...DIVYA, note: "vendor re-issued with corrected bag count" });
    expect(rep.ok).toBe(true);
    expect((await get(s1.run_id)).state).toBe("SUPERSEDED");
    expect((await get(v.run_id)).state).toBe("APPROVED");
    expect((await approvalsOf(deps, v.run_id))[0].mode).toBe("replacement");
  });
  it("T4d: against an APPROVED and exported run: approving the new run is refused; original unchanged", async () => {
    const { deps, get, send } = setup();
    const s1 = await send("s1.pdf", extractionOf("S1"));
    await approve(deps, [s1.run_id], DIVYA);
    await exportApproved(deps, DIVYA);
    const v = await send("s1-v.pdf", s1Variant());
    expect(v.blocking_codes).toContain("POSSIBLE_DOUBLE_BILLING");
    const r = await overrideApprove(deps, v.run_id, { ...DIVYA, note: "pay", confirmFailingChecks: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/credit-note/);
    expect(await get(s1.run_id)).toMatchObject({ state: "APPROVED", exported: true, export_blocked: false });
  });
});

describe("T6: individual and batch approval are recorded with display name, time, mode and batch id", () => {
  it("one individual, three in a batch", async () => {
    const deps = makeDeps();
    const ids = [];
    for (const t of ["S1", "S6a", "S11", "S13"]) ids.push((await deliver(deps, t, {})).run_id);
    expect((await approve(deps, [ids[0]], DIVYA)).ok).toBe(true);
    const batch = await approve(deps, ids.slice(1), { actor: "Ravi (Finance)" });
    expect(batch.ok).toBe(true);
    const all = (await deps.store.logs()).approvals;
    expect(all.map((a) => a.mode)).toEqual(["individual", "batch", "batch", "batch"]);
    expect(new Set(all.slice(1).map((a) => a.batch_id)).size).toBe(1);
    expect(all[1].approver_display_name).toBe("Ravi (Finance)");
    expect(all.every((a) => a.approved_at)).toBe(true);
  });
  it("a batch with one ineligible run is refused as a whole", async () => {
    const deps = makeDeps();
    const a = await deliver(deps, "S1", {});
    const b = await deliver(deps, "S2", {}); // ON_HOLD
    expect((await approve(deps, [a.run_id, b.run_id], DIVYA)).ok).toBe(false);
    expect(await deps.store.read((s) => s.runs.get(a.run_id)!.state)).toBe("CLEARED");
  });
});

describe("T8: repeated or stale actions are no-ops", () => {
  it("a second click with the old version is ACTION_REPEAT_IGNORED; one approval only", async () => {
    const deps = makeDeps();
    const s1 = await deliver(deps, "S1", {});
    const v = s1.version;
    expect((await approve(deps, [s1.run_id], { ...DIVYA, expectedVersion: v })).ok).toBe(true);
    const again = await approve(deps, [s1.run_id], { ...DIVYA, expectedVersion: v });
    expect(!again.ok && again.code).toBe("ACTION_REPEAT_IGNORED");
    expect((await deps.store.logs()).approvals).toHaveLength(1);
    expect((await eventsOf(deps, s1.run_id)).filter((e) => e.type === "ACTION_REPEAT_IGNORED")).toHaveLength(1);
  });
  it("sending the correction twice issues one token only", async () => {
    const deps = makeDeps();
    const s3 = await deliver(deps, "S3", {});
    expect((await requestCorrection(deps, s3.run_id, { ...DIVYA, expectedVersion: s3.version })).ok).toBe(true);
    expect((await requestCorrection(deps, s3.run_id, { ...DIVYA, expectedVersion: s3.version })).ok).toBe(false);
    expect((await deps.store.logs()).corrections).toHaveLength(1);
  });
});

describe("T9, F5, F1: failures and retry", () => {
  it("F5: transport errors end FAILED with no decision; T9: retry keeps the run id and decides once", async () => {
    const { deps, synthetic, get } = setup();
    synthetic.set("s1.pdf", { status: "transport_error", error: "429 rate limited", attempts: 3, label: "MOCK" });
    const run = await ingest(deps, { source: "upload", sender_email: null, uploader_display_name: "Divya (AP)", provider_email_id: null, attachment_id: null, filename: "s1.pdf", content_type: "application/pdf", bytes: new Uint8Array(), subject: null, reply_token: null, text_layer: textFrom(extractionOf("S1")), has_text_layer: true });
    expect(run.state).toBe("FAILED");
    expect(run.engine).toBeNull();
    synthetic.set("s1.pdf", extractionOf("S1"));
    const r = await retry(deps, run.run_id, DIVYA);
    expect(r.ok && r.value.run_id).toBe(run.run_id);
    expect((await get(run.run_id)).state).toBe("CLEARED");
    expect((await eventsOf(deps, run.run_id)).filter((e) => e.type === "DECIDED")).toHaveLength(1);
  });
  it("F1: schema-invalid twice -> ON_HOLD EXTRACTION_FAILED", async () => {
    const { deps, synthetic, send } = setup();
    const e = extractionOf("S1");
    synthetic.set("bad.pdf", { status: "schema_invalid", errors: ["total: expected string"], attempts: 2, label: "MOCK" });
    const run = await ingest(deps, { source: "upload", sender_email: null, uploader_display_name: "Divya (AP)", provider_email_id: null, attachment_id: null, filename: "bad.pdf", content_type: "application/pdf", bytes: new Uint8Array(), subject: null, reply_token: null, text_layer: textFrom(e), has_text_layer: true });
    expect(run.state).toBe("ON_HOLD");
    expect(run.blocking_codes).toEqual(["EXTRACTION_FAILED"]);
    void send;
  });
});

describe("T10: export takes only APPROVED, unblocked, unexported runs; re-export is impossible", () => {
  it("CLEARED, APPROVED, export-blocked and exported runs present", async () => {
    const { deps, get, send } = setup();
    const a = await send("a.pdf", extractionOf("S1")); // will be export-blocked
    const b = await send("b.pdf", extractionOf("S6a")); // approved
    const c = await send("c.pdf", extractionOf("S11")); // stays CLEARED
    await approve(deps, [a.run_id, b.run_id], DIVYA);
    await send("a-v.pdf", s1Variant()); // blocks a
    const first = await exportApproved(deps, { actor: "Ravi (Finance)" });
    expect(first.ok && first.value.record.run_ids).toEqual([b.run_id]);
    expect(first.ok && first.value.record.created_by_display_name).toBe("Ravi (Finance)");
    expect((await get(c.run_id)).exported).toBe(false);
    expect((await get(a.run_id)).exported).toBe(false);
    expect((await eventsOf(deps, b.run_id)).filter((e) => e.type === "EXPORTED")).toHaveLength(1);
    expect((await exportApproved(deps, DIVYA)).ok).toBe(false); // nothing left: re-export impossible
  });
});

describe("T11: chain invariant", () => {
  it("override approval is refused while another run in the chain is payable", async () => {
    const { deps, send } = setup();
    const s1 = await send("s1.pdf", extractionOf("S1"));
    await approve(deps, [s1.run_id], DIVYA);
    const v = await send("s1-v.pdf", s1Variant());
    const r = await overrideApprove(deps, v.run_id, { ...DIVYA, note: "both are fine", confirmFailingChecks: true });
    expect(!r.ok && r.reason).toMatch(/CHAIN_INVARIANT/);
  });
});

describe("T12: reviewer link confirmation (row 16)", () => {
  it("X2 (only CORRECTION_UNCONFIRMED): S3 SUPERSEDED and X2 APPROVED", async () => {
    const deps = makeDeps();
    const s3 = await deliver(deps, "S3", {});
    const x2 = await deliver(deps, "X2", {});
    const r = await confirmCorrectionLink(deps, x2.run_id, { ...DIVYA, note: "Kumar confirmed by phone this replaces INV-552" });
    expect(r.ok).toBe(true);
    const st = await deps.store.read((s) => [s.runs.get(s3.run_id)!.state, s.runs.get(x2.run_id)!.state]);
    expect(st).toEqual(["SUPERSEDED", "APPROVED"]);
    expect((await approvalsOf(deps, x2.run_id))[0].mode).toBe("link-confirmation");
  });
  it("X1 (failed check): refused; S3 not superseded", async () => {
    const deps = makeDeps();
    const s3 = await deliver(deps, "S3", {});
    const tok = await requestCorrection(deps, s3.run_id, DIVYA);
    const x1 = await deliver(deps, "X1", { S3: tok.ok ? tok.value.token : "" });
    expect((await confirmCorrectionLink(deps, x1.run_id, { ...DIVYA, note: "force" })).ok).toBe(false);
    expect(await deps.store.read((s) => s.runs.get(s3.run_id)!.state)).toBe("ON_HOLD");
  });
});

describe("T13: demo identity", () => {
  it("no display name, no action; the name is stored on approvals and events", async () => {
    const deps = makeDeps();
    const s1 = await deliver(deps, "S1", {});
    const r = await approve(deps, [s1.run_id], { actor: "  " });
    expect(!r.ok && r.code).toBe("IDENTITY_REQUIRED");
    await approve(deps, [s1.run_id], { actor: "Divya (AP)" });
    expect((await eventsOf(deps, s1.run_id)).find((e) => e.to_state === "APPROVED")!.actor).toBe("Divya (AP)");
  });
});

describe("T14, T15: manual hold and dispute resolution", () => {
  it("T14: manual hold of a CLEARED run -> ON_HOLD MANUAL_HOLD; its consumption stops counting", async () => {
    const deps = makeDeps();
    await deliver(deps, "S6a", {});
    const s6a = await deps.store.read((s) => [...s.runs.values()][0]);
    expect((await manualHold(deps, s6a.run_id, { ...DIVYA, note: "checking delivery note" })).ok).toBe(true);
    const s6b = await deliver(deps, "S6b", {}); // 12 of 25 now fits: S6a no longer consumes
    expect(s6b.blocking_codes).toEqual([]);
    expect(await deps.store.read((s) => s.runs.get(s6a.run_id)!.blocking_codes)).toEqual(["MANUAL_HOLD"]);
  });
  it("T15: rejecting the disputing run lifts the original's export block in the same transaction", async () => {
    const { deps, get, send } = setup();
    const s1 = await send("s1.pdf", extractionOf("S1"));
    await approve(deps, [s1.run_id], DIVYA);
    const v = await send("s1-v.pdf", s1Variant());
    expect((await get(s1.run_id)).export_blocked).toBe(true);
    expect((await reject(deps, v.run_id, { ...DIVYA, note: "vendor sent this by mistake" })).ok).toBe(true);
    expect((await get(s1.run_id)).export_blocked).toBe(false);
    const ex = await exportApproved(deps, DIVYA);
    expect(ex.ok && ex.value.record.run_ids).toEqual([s1.run_id]);
  });
});

describe("T16: concurrent decisions on one PO are serialised", () => {
  it("S6a and a copy (different number and date) at the same time: one clears, the other holds", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const { send } = setup(gate);
    const copy = extractionOf("S6a");
    copy.invoice_number = "BF-3399";
    copy.invoice_date = "2026-10-11";
    const both = Promise.all([send("6a.pdf", extractionOf("S6a")), send("6a-copy.pdf", copy)]);
    open();
    const runs: RunRecord[] = await both;
    const states = runs.map((r) => r.state).sort();
    expect(states).toEqual(["CLEARED", "ON_HOLD"]);
    const held = runs.find((r) => r.state === "ON_HOLD")!;
    expect(held.blocking_codes.sort()).toEqual(["PO_AMOUNT_EXCEEDED", "QTY_EXCEEDS_PO"]);
  });
});

describe("T17 and F7: upload trust and repeated deliveries", () => {
  it("T17: upload S1 -> CLEARED; K3 not evaluated with the uploader's name; source upload", async () => {
    const { send } = setup();
    const r = await send("up.pdf", extractionOf("S1"), { source: "upload", uploader: "Divya (AP)" });
    expect(r.state).toBe("CLEARED");
    expect(r.source).toBe("upload");
    expect(r.engine!.stages.find((s) => s.stage === "vendor")!.notes.join(" ")).toContain("internal upload by Divya (AP) (demo identity)");
  });
  it("F7: the same email delivered twice -> one run; DELIVERY_REPEAT_IGNORED", async () => {
    const deps = makeDeps();
    const a = await deliver(deps, "S1", {});
    const b = await deliver(deps, "S1", {});
    expect(b.run_id).toBe(a.run_id);
    expect(await deps.store.read((s) => s.runs.size)).toBe(1);
    expect((await eventsOf(deps, a.run_id)).filter((e) => e.type === "DELIVERY_REPEAT_IGNORED")).toHaveLength(1);
  });
  it("upload idempotency: the same file again within 60 s returns the existing run; after 60 s it is a new run", async () => {
    let t = Date.UTC(2026, 9, 22, 9, 0, 0);
    const deps: PipelineDeps = { ...makeDeps(), now: () => new Date(t).toISOString() };
    const up = () => ingest(deps, {
      source: "upload", sender_email: null, uploader_display_name: "Divya (AP)", provider_email_id: null, attachment_id: null,
      filename: "S01_FreshPack_FP-2026-0418.pdf", content_type: "application/pdf", bytes: new Uint8Array([1]), sha256: "same-file",
      subject: null, reply_token: null, text_layer: textFrom(extractionOf("S1")), has_text_layer: true,
    });
    const a = await up();
    t += 59_000;
    const b = await up();
    expect(b.run_id).toBe(a.run_id);
    expect((await eventsOf(deps, a.run_id)).filter((e) => e.type === "DELIVERY_REPEAT_IGNORED")).toHaveLength(1);
    t += 2_000;
    const c = await up();
    expect(c.run_id).not.toBe(a.run_id);
    expect(c.state).toBe("REJECTED"); // the same invoice again is then a duplicate (D1)
  });
  it("row 5: a SKIPPED quotation processed as an invoice runs every other check", async () => {
    const deps = makeDeps();
    const q = await deliver(deps, "S9", {});
    expect(q.state).toBe("SKIPPED");
    const r = await processAsInvoice(deps, q.run_id, { ...DIVYA, note: "vendor confirms this is their invoice" });
    expect(r.ok && r.value.state).not.toBe("SKIPPED");
    expect(r.ok && r.value.g1_bypassed).toBe(true);
  });
});
