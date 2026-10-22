import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadEmail, TEST_DATA_DIR } from "@/fixtures/load";
import { ingestEmail } from "@/server/email-intake";
import { failStuckRuns, ingest, receive, receiveUnreadable, type PipelineDeps } from "@/domain/runs/pipeline";
import { availableActions, nextRef } from "@/domain/runs/queries";
import { eventsOf, retry } from "@/domain/runs/review";
import { extractionOf, textFrom } from "./support/direct";
import { deliver, makeDeps } from "./support/harness";

// Intake skips (stage 0), interrupted processing (row 3 recovery), action offers and run references.

describe("stage 0 skips are recorded as SKIPPED runs", () => {
  it("an unsupported upload is SKIPPED UNSUPPORTED_FILE with its reason, through rows 1 and 2", async () => {
    const deps = makeDeps();
    const run = await receiveUnreadable(deps, {
      source: "upload", sender_email: null, uploader_display_name: "Divya (AP)", provider_email_id: null, attachment_id: null,
      filename: "invoice.docx", content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size_bytes: 1234,
      subject: null, reply_token: null,
    }, "UNSUPPORTED_FILE", "type application/vnd...docx is not PDF, PNG or JPEG");
    expect(run.state).toBe("SKIPPED");
    expect(run.primary_reason).toBe("UNSUPPORTED_FILE");
    const rows = (await eventsOf(deps, run.run_id)).filter((e) => e.type === "STATE_CHANGED").map((e) => e.transition);
    expect(rows).toEqual([1, 2]);
    expect(availableActions(run, { runs: new Map() })).toEqual([]); // nothing to process as an invoice
  });

  it("an email without an attachment is SKIPPED NO_ATTACHMENT once, even if the webhook repeats", async () => {
    const deps = makeDeps();
    const doc = { source: "email" as const, sender_email: "billing@freshpack.example", uploader_display_name: null, provider_email_id: "em-1", attachment_id: null, filename: null, content_type: null, size_bytes: null, subject: "hello", reply_token: null };
    const a = await receiveUnreadable(deps, doc, "NO_ATTACHMENT", "the email has no attachment");
    const b = await receiveUnreadable(deps, doc, "NO_ATTACHMENT", "the email has no attachment");
    expect(b.run_id).toBe(a.run_id);
    expect(await deps.store.read((s) => s.runs.size)).toBe(1);
  });
});

describe("interrupted processing", () => {
  it("a run left in PROCESSING is FAILED PROCESSING_ERROR after the timeout (row 3) and can be retried (row 4)", async () => {
    let t = Date.UTC(2026, 9, 22, 9, 0, 0);
    const deps: PipelineDeps = { ...makeDeps(), now: () => new Date(t).toISOString() };
    const r = await receive(deps, {
      source: "upload", sender_email: null, uploader_display_name: "Divya (AP)", provider_email_id: null, attachment_id: null,
      filename: "S01_FreshPack_FP-2026-0418.pdf", content_type: "application/pdf", bytes: new Uint8Array([1]), subject: null, reply_token: null,
      text_layer: textFrom(extractionOf("S1")), has_text_layer: true,
    });
    // Simulate a function that died after starting: move the run to PROCESSING and never finish.
    await deps.store.transaction((tx) => {
      const run = tx.runs.get(r.run_id)!;
      run.state = "PROCESSING";
      run.updated_at = new Date(t).toISOString();
    });
    t += 60_000;
    expect(await failStuckRuns(deps, 120_000)).toEqual([]);
    t += 61_000;
    expect(await failStuckRuns(deps, 120_000)).toEqual([r.run_id]);
    const failed = await deps.store.read((s) => s.runs.get(r.run_id)!);
    expect(failed.state).toBe("FAILED");
    expect(failed.failure).toMatch(/PROCESSING_ERROR/);
    const again = await retry(deps, r.run_id, { actor: "Divya (AP)" });
    expect(again.ok && again.value.state).toBe("CLEARED");
  });
});

describe("action offers and references", () => {
  it("offers follow the section 11 user rows", async () => {
    const deps = makeDeps();
    const s1 = await deliver(deps, "S1", {});
    const s3 = await deliver(deps, "S3", {});
    const s9 = await deliver(deps, "S9", {});
    const runs = await deps.store.read((s) => s.runs);
    const names = (id: string) => availableActions(runs.get(id)!, { runs }).map((a) => a.action);
    expect(names(s1.run_id)).toEqual(["approve", "manual_hold"]);
    expect(names(s3.run_id)).toEqual(["request_correction", "override_approve", "reject"]);
    expect(names(s9.run_id)).toEqual(["process_as_invoice"]);
  });

  it("nextRef counts up from A0001", async () => {
    const deps: PipelineDeps = { ...makeDeps(), newRef: nextRef };
    const up = (name: string) => ingest(deps, {
      source: "upload", sender_email: null, uploader_display_name: "Divya (AP)", provider_email_id: null, attachment_id: null,
      filename: name, content_type: "application/pdf", bytes: new Uint8Array([1]), subject: null, reply_token: null, text_layer: "", has_text_layer: false,
    });
    expect((await up("a.pdf")).ref).toBe("A0001");
    expect((await up("b.pdf")).ref).toBe("A0002");
  });
});

describe("email intake adapter (ingestEmail)", () => {
  const email = (over: Partial<import("@/domain/types").InboundEmail> = {}) => ({ ...loadEmail("S1"), ...over });

  it("S1 recorded email: recorded first, processed as deferred work, CLEARED", async () => {
    const deps = makeDeps();
    const e = email();
    const r = await ingestEmail(deps, e, async () => new Uint8Array(readFileSync(path.join(TEST_DATA_DIR, e.attachments[0].path))));
    expect(r.run_ids).toHaveLength(1);
    expect((await deps.store.read((s) => s.runs.get(r.run_ids[0])!)).state).toBe("RECEIVED");
    await Promise.all(r.work.map((w) => w()));
    expect((await deps.store.read((s) => s.runs.get(r.run_ids[0])!)).state).toBe("CLEARED");
  });

  it("F8: the attachment cannot be fetched 3 times -> FAILED ATTACHMENT_FETCH_FAILED, no retry offered", async () => {
    const deps = makeDeps();
    let calls = 0;
    const r = await ingestEmail(deps, email(), async () => { calls++; throw new Error("provider 503"); }, async () => {});
    expect(calls).toBe(3);
    const run = await deps.store.read((s) => s.runs.get(r.run_ids[0])!);
    expect(run.state).toBe("FAILED");
    expect(run.primary_reason).toBe("ATTACHMENT_FETCH_FAILED");
    expect(run.failure).toMatch(/after 3 attempts: provider 503/);
    expect(availableActions(run, { runs: new Map() })).toEqual([]);
  });

  it("an email without attachments -> SKIPPED NO_ATTACHMENT; an unsupported attachment -> SKIPPED UNSUPPORTED_FILE", async () => {
    const deps = makeDeps();
    const none = await ingestEmail(deps, email({ provider_email_id: "e-none", attachments: [] }), async () => new Uint8Array());
    expect((await deps.store.read((s) => s.runs.get(none.run_ids[0])!)).primary_reason).toBe("NO_ATTACHMENT");
    const docx = await ingestEmail(deps, email({ provider_email_id: "e-docx", attachments: [{ filename: "inv.docx", path: "", content_type: "application/msword" }] }), async () => new Uint8Array([1, 2]));
    const run = await deps.store.read((s) => s.runs.get(docx.run_ids[0])!);
    expect([run.state, run.primary_reason]).toEqual(["SKIPPED", "UNSUPPORTED_FILE"]);
  });
});
