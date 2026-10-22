import { describe, expect, it } from "vitest";
import { nextToken } from "@/domain/runs/actions";
import { requestCorrection } from "@/domain/runs/review";
import { detail } from "@/server/views";
import { deliver, makeDeps } from "./support/harness";

// Spec v1.4 D2 (decision Q7): reply tokens come from a secret random seed per run, not from anything the app shows.
// The same request still shows one token from preview to record, so the email sent is the email recorded.

let secrets = 0;
const withSecrets = (tag: string) => ({ ...makeDeps(), newSecret: () => `${tag}-secret-${++secrets}` });

describe("reply tokens (Q7)", () => {
  it("the same run reference and run id give different tokens when the secret seeds differ", async () => {
    const a = withSecrets("a");
    const b = withSecrets("b");
    const ra = await deliver(a, "S3", {});
    const rb = await deliver(b, "S3", {});
    expect([ra.ref, ra.run_id]).toEqual([rb.ref, rb.run_id]); // what the app shows is identical
    expect(ra.token_seed).toBeTruthy();
    const ta = await a.store.read((s) => nextToken(s, s.runs.get(ra.run_id)!));
    const tb = await b.store.read((s) => nextToken(s, s.runs.get(rb.run_id)!));
    expect(ta).toMatch(new RegExp(`^R-${ra.ref}[0-9A-Z]{4}$`));
    expect(ta).not.toBe(tb);
  });

  it("the token previewed in the email is the token recorded, and the seed is never in the screen's data", async () => {
    const deps = withSecrets("c");
    const run = await deliver(deps, "S3", {});
    const state = await deps.store.read((s) => ({ runs: s.runs, documents: s.documents, tokens: s.tokens }));
    const d = detail(run, state, await deps.store.logs(run.run_id), deps.reference);
    expect(JSON.stringify(d)).not.toContain(run.token_seed!);
    const r = await requestCorrection(deps, run.run_id, { actor: "Divya (AP)", channel: "marked sent manually" });
    expect(r.ok && r.value.token).toBe(d.correction_draft!.token);
    const second = await deps.store.read((s) => nextToken(s, s.runs.get(run.run_id)!));
    expect(second).not.toBe(d.correction_draft!.token); // a new token for the next request
  });

  it("a run from before v1.4 (no seed) keeps its run-id token", async () => {
    const deps = makeDeps();
    const run = await deliver(deps, "S3", {});
    expect(run.token_seed).toBeUndefined();
    expect(await deps.store.read((s) => nextToken(s, s.runs.get(run.run_id)!))).toMatch(/^R-T\d{4}[0-9A-Z]{4}$/);
  });
});
