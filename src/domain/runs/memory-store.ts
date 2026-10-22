import type { Logs, RunStore, StoreState } from "./types";

// In-memory implementation of the store port, for the golden run, domain tests and local development without a
// database. It follows the same contract as the Postgres store: transactions are serialised and atomic, run on a
// deep copy, start with empty logs, and return detached copies (changing a returned object changes nothing).

type Core = Pick<StoreState, "runs" | "documents" | "tokens" | "deliveries">;

export function emptyState(): StoreState {
  return {
    runs: new Map(), documents: new Map(), tokens: new Map(), deliveries: new Set(),
    events: [], approvals: [], exports: [], corrections: [], newFiles: new Map(),
  };
}

export function assertSync<T>(out: T): T {
  if (out && typeof (out as { then?: unknown }).then === "function") {
    throw new Error("store transaction functions must be synchronous: do slow work between transactions");
  }
  return out;
}

export class MemoryRunStore implements RunStore {
  private core: Core = { runs: new Map(), documents: new Map(), tokens: new Map(), deliveries: new Set() };
  private log: Logs = { events: [], approvals: [], exports: [], corrections: [] };
  private files = new Map<string, Uint8Array>();
  private queue: Promise<unknown> = Promise.resolve();

  transaction<T>(fn: (tx: StoreState) => T): Promise<T> {
    const run = async () => {
      const draft: StoreState = { ...structuredClone(this.core), events: [], approvals: [], exports: [], corrections: [], newFiles: new Map() };
      const out = assertSync(fn(draft));
      // Commit: swap in the new state and append the logs.
      this.core = { runs: draft.runs, documents: draft.documents, tokens: draft.tokens, deliveries: draft.deliveries };
      for (const e of draft.events) this.log.events.push({ ...e, seq: this.log.events.length + 1 });
      this.log.approvals.push(...draft.approvals);
      this.log.exports.push(...draft.exports);
      this.log.corrections.push(...draft.corrections);
      for (const [id, bytes] of draft.newFiles) this.files.set(id, bytes.slice());
      return structuredClone(out);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  async read<T>(fn: (state: StoreState) => T): Promise<T> {
    await this.queue;
    return assertSync(fn({ ...structuredClone(this.core), events: [], approvals: [], exports: [], corrections: [], newFiles: new Map() }));
  }

  async logs(runId?: string): Promise<Logs> {
    await this.queue;
    const l = structuredClone(this.log);
    if (!runId) return l;
    return {
      events: l.events.filter((e) => e.run_id === runId),
      approvals: l.approvals.filter((a) => a.run_id === runId),
      exports: l.exports.filter((x) => x.run_ids.includes(runId)),
      corrections: l.corrections.filter((c) => c.run_id === runId),
    };
  }

  async documentBytes(runId: string): Promise<Uint8Array | null> {
    await this.queue;
    return this.files.get(runId)?.slice() ?? null;
  }
}
