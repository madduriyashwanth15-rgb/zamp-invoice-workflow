import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approve, exportApproved } from "@/domain/runs/review";
import { replay } from "@/server/demo";
import { runtime } from "@/server/runtime";
import { auditCsv } from "@/server/service";

// Review gap 15: the whole audit trail downloads as one CSV, every recorded event in order, formula-safe like the
// payment list (A09). In-memory store, MOCK reader.

/** Minimal CSV parser for the rows this file writes (every cell quoted, quotes doubled). */
function parse(csv: string): string[][] {
  return csv.trim().split("\r\n").map((line) => [...line.matchAll(/"((?:[^"]|"")*)"|([^,]+)/g)].map((m) => (m[1] ?? m[2]).replace(/""/g, '"')));
}

describe("audit log CSV", () => {
  beforeEach(() => {
    for (const k of ["DATABASE_URL", "GEMINI_API_KEY", "GEMINI_MODEL", "RESEND_API_KEY", "AP_INBOX_ADDRESS"]) vi.stubEnv(k, "");
    (globalThis as { __ps1Runtime?: unknown }).__ps1Runtime = undefined;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    (globalThis as { __ps1Runtime?: unknown }).__ps1Runtime = undefined;
  });

  it("lists every event the store holds, in order, with the run reference, states, codes and demo identities", async () => {
    const { deps } = runtime();
    for (const id of ["S1", "S2"]) {
      const r = await replay(id);
      for (const w of r.work) await w();
    }
    const s1 = [...(await deps.store.read((s) => [...s.runs.values()]))].find((r) => r.state === "CLEARED")!;
    expect((await approve(deps, [s1.run_id], { actor: "=Divya" })).ok).toBe(true);
    expect((await exportApproved(deps, { actor: "Ravi (Finance)" })).ok).toBe(true);

    const rows = parse(await auditCsv());
    const [header, ...body] = rows;
    expect(header).toEqual(["seq", "at", "run_ref", "run_id", "event", "actor", "from_state", "to_state", "transition_row", "reason_code", "note", "details_json"]);
    const logs = await deps.store.logs();
    expect(body.length).toBe(logs.events.length);
    const seqs = body.map((r) => Number(r[0]));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(body.some((r) => r[2] === s1.ref && r[4] === "STATE_CHANGED" && r[7] === "APPROVED")).toBe(true);
    expect(body.some((r) => r[4] === "EXPORTED" && r[5] === "Ravi (Finance) (demo identity)")).toBe(true);
    expect(body.some((r) => r[9] === "BANK_DETAILS_CHANGED")).toBe(true);
    // A reviewer name that looks like a formula is text, never a formula.
    expect(body.some((r) => r[5] === "'=Divya (demo identity)")).toBe(true);
    // Details are valid JSON.
    for (const r of body) if (r[11]) expect(() => JSON.parse(r[11])).not.toThrow();
  });

  it("reading the log changes nothing (the route itself is checked on a running server)", async () => {
    const { deps } = runtime();
    const r = await replay("S1");
    for (const w of r.work) await w();
    const versions = () => deps.store.read((s) => [...s.runs.values()].map((x) => `${x.run_id}:${x.version}`));
    const before = await versions();
    const eventsBefore = (await deps.store.logs()).events.length;
    expect((await auditCsv()).startsWith("seq,at,run_ref,")).toBe(true);
    expect(await versions()).toEqual(before);
    expect((await deps.store.logs()).events.length).toBe(eventsBefore);
  });
});
