import { readFileSync } from "node:fs";
import path from "node:path";
import { MemoryRunStore } from "@/domain/runs/memory-store";
import { loadAnswerKey, loadEmail, TEST_DATA_DIR } from "@/fixtures/load";
import { PgRunStore } from "@/server/db/pg-store";
import { ingestEmail, type EmailIntakeResult } from "@/server/email-intake";
import { runtime } from "@/server/runtime";

// Demo tools. "Replay" feeds a RECORDED test email (test-data/emails) through the real email intake adapter, as if
// the vendor had just sent it: the email provider is simulated, everything after it is the real pipeline.

export const SCENARIOS: Record<string, string> = {
  S1: "FreshPack: clean invoice",
  S2: "CleanCo: bank account changed",
  S3: "Kumar Vegetables: price above the PO",
  S4: "Kumar Vegetables: corrected invoice replying to the S3 request",
  S5: "FreshPack: S1 sent again with a reformatted number",
  S6a: "BlueFlame: first gas delivery",
  S6b: "BlueFlame: second delivery beyond the PO",
  S7: "Sharma Kitchen: scanned invoice, no PO printed",
  S8: "QuickServe: unknown vendor, unregistered sender",
  S9: "FreshPack: a quotation, not an invoice",
  S10: "CleanCo: totals that do not add up",
  S11: "FreshPack: price slightly above the PO, within tolerance",
  S12: "Sharma Kitchen: lump-sum service",
  S13: "UrbanLinen: GST-inclusive prices",
  S14: "FreshPack: packs instead of pieces (AI line proposal)",
  X1: "Kumar Vegetables: correction that is still too high",
  X2: "Kumar Vegetables: correction without the reference",
  X3: "CleanCo: delivery charge not on the PO",
};

export function scenarios() {
  const key = loadAnswerKey();
  return key.tests.map((t) => ({ test_id: t.test_id, title: SCENARIOS[t.test_id] ?? t.test_id, file: path.basename(t.file as string), sender: t.sender as string, needs_token_of: (t.reply_token_of as string | null) ?? null }));
}

/** The attachment of a recorded test email, for download (only known test ids; no path from the request is used). */
export function sampleFile(testId: string): { bytes: Uint8Array; filename: string; content_type: string } | null {
  if (!loadAnswerKey().tests.some((t) => t.test_id === testId)) return null;
  const email = JSON.parse(readFileSync(path.join(TEST_DATA_DIR, "emails", `${testId}.json`), "utf-8")) as {
    attachments: { filename: string; path: string; content_type: string }[];
  };
  const att = email.attachments[0];
  if (!att) return null;
  return { bytes: new Uint8Array(readFileSync(path.join(TEST_DATA_DIR, att.path))), filename: att.filename, content_type: att.content_type };
}

/** Replays one recorded email. A reply that must carry our token gets the token actually issued in this app. */
export async function replay(testId: string): Promise<EmailIntakeResult> {
  const { deps } = runtime();
  const t = loadAnswerKey().tests.find((x) => x.test_id === testId);
  if (!t) throw new Error(`no recorded email ${testId}`);
  const tokens: Record<string, string> = {};
  const raw = readFileSync(path.join(TEST_DATA_DIR, "emails", `${testId}.json`), "utf-8");
  for (const m of raw.matchAll(/\{\{TOKEN:([^}]+)\}\}/g)) {
    const of = m[1];
    const file = path.basename(loadAnswerKey().tests.find((x) => x.test_id === of)!.file as string);
    const token = await deps.store.read((s) => {
      const runs = [...s.runs.values()].filter((r) => r.filename === file);
      const issued = [...s.tokens].filter(([, id]) => runs.some((r) => r.run_id === id));
      return issued.at(-1)?.[0] ?? null;
    });
    if (!token) throw new Error(`${testId} is a reply to ${of}: request a correction on the ${of} invoice first, so a reference exists to reply to`);
    tokens[of] = token;
  }
  const email = loadEmail(testId, tokens);
  // Each replay is a new delivery (a new provider email id), so it can be shown more than once.
  const stamped = { ...email, provider_email_id: `${email.provider_email_id}-replay-${Date.now()}` };
  return ingestEmail(deps, stamped, async (i) => new Uint8Array(readFileSync(path.join(TEST_DATA_DIR, email.attachments[i].path))));
}

/**
 * Empties every run. Saved readings (the extraction cache) are kept unless `forgetReadings` is set; then the next
 * run of each file calls the AI again, which is what a live demo of real reading needs (and costs quota).
 * Returns how many saved readings were forgotten (null when none were asked to be, or the MOCK reader is active).
 */
export async function resetDemo(opts: { forgetReadings?: boolean } = {}): Promise<{ forgotten: number | null }> {
  const rt = runtime();
  if (rt.deps.store instanceof PgRunStore) await rt.deps.store.reset();
  else rt.deps.store = new MemoryRunStore();
  if (!opts.forgetReadings || !rt.cache) return { forgotten: null };
  return { forgotten: await rt.cache.clear() };
}
