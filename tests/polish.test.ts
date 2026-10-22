import { describe, expect, it } from "vitest";
import type { PipelineDeps } from "@/domain/runs/pipeline";
import { approve, exportApproved, overrideApprove, requestCorrection } from "@/domain/runs/review";
import type { RunRecord } from "@/domain/runs/types";
import { GeminiExtractor, MemoryExtractionCache } from "@/server/extractor/gemini-extractor";
import type { GeminiTransport } from "@/server/extractor/gemini-transport";
import { detail, plainNote, reviewStage, type RunDetail } from "@/server/views";
import { deliver, makeDeps, reference, tests } from "./support/harness";

// Review of the live screens, 22 Oct: findings fixed with a test each.
const DIVYA = { actor: "Divya (AP)" };

describe("due date on every approval (finance needs it on the payment list)", () => {
  it("S1 from an unregistered sender, approved with an exception: due = invoice date + 30 days, and it is on the export", async () => {
    const deps = makeDeps();
    const run = await deliver(deps, "S1", {}, { emailOverride: (_id, e) => ({ ...e, from: "someone@unregistered.example" }) });
    expect(run.blocking_codes).toEqual(["SENDER_UNVERIFIED"]);
    expect(run.due_date).toBeNull();
    const r = await overrideApprove(deps, run.run_id, { ...DIVYA, note: "Sender confirmed by phone on the vendor-master number" });
    expect(r.ok && r.value.due_date).toBe("2026-11-11"); // 12 Oct + 30 days (FreshPack terms)
    const x = await exportApproved(deps, DIVYA);
    expect(x.ok && x.value.runs.map((v) => v.due_date)).toEqual(["2026-11-11"]);
  });

  it("an invoice cleared by code keeps the due date the code set; approving does not change it", async () => {
    const deps = makeDeps();
    const run = await deliver(deps, "S1", {});
    expect(run.due_date).toBe("2026-11-11");
    const r = await approve(deps, [run.run_id], DIVYA);
    expect(r.ok && r.value[0].due_date).toBe("2026-11-11");
  });

  it("unknown vendor (S8) approved with an exception: no terms to apply, the due date stays empty", async () => {
    const deps = makeDeps();
    const run = await deliver(deps, "S8", {});
    const r = await overrideApprove(deps, run.run_id, { ...DIVYA, note: "One-off supplier, checked by phone" });
    expect(r.ok && r.value.state).toBe("APPROVED");
    expect(r.ok && r.value.due_date).toBeNull();
  });
});

// ---- fixes 2, 3, 5: what the screens say (view models built from the real pipeline, MOCK extractor) ----

async function viewOf(deps: PipelineDeps, runId: string) {
  const state = await deps.store.read((s) => ({ run: s.runs.get(runId)!, runs: s.runs, documents: s.documents, tokens: s.tokens }));
  return detail(state.run, state, await deps.store.logs(runId), deps.reference);
}
const stage = (d: RunDetail, id: string) => d.stages.find((s) => s.id === id)!;
const texts = (d: RunDetail) => d.stages.flatMap((s) => s.notes.map((n) => n.text));

describe("a check that did not run is never reported as failed (fix 2)", () => {
  it("S9 quotation from a registered vendor: skipped, vendor and PO 'not checked', never 'not in vendor master'", async () => {
    const deps = makeDeps();
    const run = await deliver(deps, "S9", {});
    expect(run.state).toBe("SKIPPED");
    const d = await viewOf(deps, run.run_id);
    expect(d.vendor).toBeTruthy();
    expect(d.vendor_known).toBe(false);
    expect(d.vendor_checked).toBe(false);
    expect(d.po_checked).toBe(false);
  });

  it("S8 unknown vendor: the vendor check ran and failed; the PO check did not run", async () => {
    const deps = makeDeps();
    const d = await viewOf(deps, (await deliver(deps, "S8", {})).run_id);
    expect(d).toMatchObject({ vendor_known: false, vendor_checked: true, po_checked: false, po_number: null });
  });

  it("S1: vendor known, PO matched", async () => {
    const deps = makeDeps();
    const d = await viewOf(deps, (await deliver(deps, "S1", {})).run_id);
    expect(d).toMatchObject({ vendor_known: true, vendor_checked: true, po_checked: true });
  });
});

describe("plain-English stage notes, rule ids kept apart (fix 5)", () => {
  it.each([
    ["not evaluated: skipped at G1", null, "Not checked: this document is not an invoice"],
    ["not evaluated: vendor unknown", null, "Not checked: the vendor is not in the vendor master"],
    ["not evaluated: no PO", null, "Not checked: no purchase order was matched"],
    ["K3 not evaluated: internal upload by Divya (demo identity)", "K3", "Not checked: internal upload by Divya (demo identity)"],
    ["D1-D4 not evaluated: no invoice number", "D1-D4", "Not checked: no invoice number"],
    ["K1: vendor V01 FreshPack matched by gstin", "K1", "Vendor V01 FreshPack matched by gstin"],
    ["Outcome: ON_HOLD", null, "Decision: On hold"],
    ["Due (per terms): 2026-11-11 (30 days)", null, "Due (per terms): 11 Nov 2026, 30 days after the invoice date"],
    ['AI doc_type: quotation; title "QUOTATION"; number label "Quote No"', null, 'The AI read it as a quotation, titled "QUOTATION", number labelled "Quote No"'],
    ["C2/C3 exclude A0001's consumption", null, "C2/C3 exclude A0001's consumption"],
  ])("%s", (note, rule, text) => {
    expect(plainNote(note)).toEqual({ rule, text });
  });

  it("no engine shorthand reaches the S9 or S3 screens", async () => {
    const deps = makeDeps();
    for (const id of ["S9", "S3"]) {
      const all = texts(await viewOf(deps, (await deliver(deps, id, {})).run_id)).join("\n");
      expect(all).not.toMatch(/skipped at G1|not evaluated|Outcome: [A-Z_]+|AI doc_type/);
    }
  });
});

describe("the reviewer's decision is the last step of the routing slip (fix 3)", () => {
  it("S1 cleared: waiting for a reviewer; after approval: who approved, with the time", async () => {
    const deps = makeDeps();
    const run = await deliver(deps, "S1", {});
    let r = stage(await viewOf(deps, run.run_id), "review");
    expect(r).toMatchObject({ n: 10, title: "Reviewer decision", status: "awaiting_review", status_text: "Waiting for a reviewer" });
    await approve(deps, [run.run_id], DIVYA);
    r = stage(await viewOf(deps, run.run_id), "review");
    expect(r.status).toBe("reviewed");
    expect(r.status_text).toBe("Approved for payment list");
    expect(r.notes[0]).toMatchObject({ text: "Approved for the payment list by Divya (AP) (demo identity)" });
    expect(r.notes[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("S3 held, correction requested: the request and its state are shown; the note says nothing went to payment", async () => {
    const deps = makeDeps();
    const run = await deliver(deps, "S3", {});
    expect(stage(await viewOf(deps, run.run_id), "review").status).toBe("awaiting_review");
    await requestCorrection(deps, run.run_id, { ...DIVYA, channel: "marked sent manually" });
    const r = stage(await viewOf(deps, run.run_id), "review");
    expect(r).toMatchObject({ status: "reviewed", status_text: "Waiting for vendor" });
    expect(r.notes.map((n) => n.text)).toEqual(["Requested a correction from the vendor by Divya (AP) (demo identity)"]);
  });

  it("S8 approved with an exception: the reviewer's note is on the slip", async () => {
    const deps = makeDeps();
    const run = await deliver(deps, "S8", {});
    await overrideApprove(deps, run.run_id, { ...DIVYA, note: "One-off supplier, checked by phone" });
    const r = stage(await viewOf(deps, run.run_id), "review");
    expect(r.notes[0].text).toBe("Approved with an exception by Divya (AP) (demo identity). Note: One-off supplier, checked by phone");
  });

  it("S9 skipped: no action needed, and it says a reviewer can still process it as an invoice", async () => {
    const deps = makeDeps();
    const r = stage(await viewOf(deps, (await deliver(deps, "S9", {})).run_id), "review");
    expect(r.status).toBe("not_needed");
    expect(r.notes.map((n) => n.text)).toEqual(["Not an invoice, so there is nothing to approve.", "If it is an invoice after all, a reviewer can process it as one."]);
  });

  it("a run still being read has no reviewer step yet", async () => {
    const deps = makeDeps();
    const run = await deliver(deps, "S1", {});
    const d = await viewOf(deps, run.run_id);
    expect(reviewStage({ ...d, state: "PROCESSING" } as unknown as RunRecord, [], [])).toBeNull();
  });
});

describe("forget saved readings (fix 6)", () => {
  it("after clear(), the same file is read by the provider again instead of coming from the cache", async () => {
    const cache = new MemoryExtractionCache();
    let calls = 0;
    const transport: GeminiTransport = {
      async generate() {
        calls++;
        return { ok: true, text: JSON.stringify(tests.get("S1")!.expected_extraction) };
      },
    };
    const ex = new GeminiExtractor({ model: "m", transport, reference, cache, sleep: async () => {} });
    const input = { filename: "a.pdf", content_type: "application/pdf", bytes: new Uint8Array([1]), text_layer: "", sha256: "s1" };
    expect(await ex.extract(input)).toMatchObject({ status: "ok", attempts: 1 });
    expect(await ex.extract(input)).toMatchObject({ status: "ok", attempts: 0, cached: true });
    expect(calls).toBe(1);
    expect(await cache.clear()).toBe(1);
    expect(await ex.extract(input)).toMatchObject({ status: "ok", attempts: 1 });
    expect(calls).toBe(2);
  });
});
