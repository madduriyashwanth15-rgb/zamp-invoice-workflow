import { describe, expect, it } from "vitest";
import { MemoryRunStore } from "@/domain/runs/memory-store";
import { ingest, type PipelineDeps } from "@/domain/runs/pipeline";
import type { RunStore, StoreState } from "@/domain/runs/types";
import { deliver, makeDeps } from "./support/harness";
import { freshPgStore, usePg } from "./support/pg";

// Concurrency beyond T16: a duplicate racing its original, and unrelated invoices arriving together (found while
// replaying the scenario sequence into the running app: an over-broad re-check let unrelated arrivals exhaust
// the re-evaluation limit and strand a run in PROCESSING).

/** Makes the first `n` pre-decision snapshots wait for each other, so those evaluations overlap for certain. */
function racing(store: RunStore, n: number): RunStore {
  let arrived = 0;
  let release!: () => void;
  const all = new Promise<void>((r) => (release = r));
  const seen = new Set<number>();
  let reads = 0;
  return {
    transaction: (fn) => store.transaction(fn),
    logs: (id) => store.logs(id),
    documentBytes: (id) => store.documentBytes(id),
    read: async <T,>(fn: (s: StoreState) => T) => {
      const me = ++reads;
      const out = await store.read(fn);
      if (me <= n && !seen.has(me)) {
        seen.add(me);
        if (++arrived === n) release();
        await all;
      }
      return out;
    },
  };
}

const fresh = () => (usePg ? freshPgStore() : new MemoryRunStore());

describe("concurrent arrivals", () => {
  it("S1 and its reprint S5 evaluated at the same moment: exactly one CLEARED, the other REJECTED DUPLICATE_INVOICE", async () => {
    const deps: PipelineDeps = { ...makeDeps(), store: racing(fresh(), 2) };
    const [a, b] = await Promise.all([deliver(deps, "S1", {}), deliver(deps, "S5", {})]);
    const states = [a, b].map((r) => `${r.state}:${r.blocking_codes.join(",")}`).sort();
    expect(states).toEqual(["CLEARED:", "REJECTED:DUPLICATE_INVOICE"]);
  });

  it("six invoices from different vendors at once: all decided, none stranded or FAILED", async () => {
    const deps: PipelineDeps = { ...makeDeps(), store: racing(fresh(), 6) };
    const ids = ["S1", "S2", "S6a", "S7", "S12", "S13"];
    const runs = await Promise.all(ids.map((id) => deliver(deps, id, {})));
    expect(runs.map((r) => r.state)).toEqual(["CLEARED", "ON_HOLD", "CLEARED", "ON_HOLD", "ON_HOLD", "CLEARED"]);
  });

  it("a run that cannot settle is FAILED with a reason, never left in PROCESSING", async () => {
    // A store whose snapshot is always stale: every commit-time re-check fails.
    const inner = fresh();
    let bump = 0;
    const churn: RunStore = {
      ...inner,
      transaction: (fn) => inner.transaction(fn),
      logs: (id) => inner.logs(id),
      documentBytes: (id) => inner.documentBytes(id),
      read: async (fn) => {
        // Another FreshPack run changes after every snapshot.
        const out = await inner.read(fn);
        await inner.transaction((tx) => {
          const other = [...tx.runs.values()].find((r) => r.ref === "OTHER");
          if (other) {
            other.version += 1;
            bump++;
          }
        });
        return out;
      },
    };
    const deps: PipelineDeps = { ...makeDeps(), store: churn };
    await deliver(deps, "S11", {}); // FreshPack, decided first
    await churn.transaction((tx) => {
      const r = [...tx.runs.values()][0];
      r.ref = "OTHER";
    });
    const run = await ingest(deps, {
      source: "upload", sender_email: null, uploader_display_name: "Divya (AP)", provider_email_id: null, attachment_id: null,
      filename: "S01_FreshPack_FP-2026-0418.pdf", content_type: "application/pdf", bytes: new Uint8Array([1]), subject: null, reply_token: null,
      text_layer: "FP-2026-0418 18,880.00 PO-1001 13,000.00 6.50 3,000.00 3.00 4417", has_text_layer: true,
    });
    expect(bump).toBeGreaterThan(0);
    expect(run.state).toBe("FAILED");
    expect(run.failure).toMatch(/kept changing/);
  });
});
