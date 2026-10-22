import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { MappingProposer, ReferenceData } from "@/domain/engine/types";
import { MemoryRunStore } from "@/domain/runs/memory-store";
import type { Extractor, PipelineDeps } from "@/domain/runs/pipeline";
import { nextRef } from "@/domain/runs/queries";
import type { RunStore } from "@/domain/runs/types";
import { loadReferenceData } from "@/fixtures/load";
import { PgExtractionCache } from "@/server/db/pg-cache";
import { PgRunStore } from "@/server/db/pg-store";
import { AnswerKeyExtractor, AnswerKeyProposer } from "@/server/extractor/answer-key-extractor";
import { GeminiExtractor, GeminiMappingProposer, MemoryExtractionCache } from "@/server/extractor/gemini-extractor";
import { transportFromEnv } from "@/server/extractor/gemini-transport";

// Wires the domain to real infrastructure from environment variables. Nothing here decides anything.
//   DATABASE_URL     Postgres (Neon demo database). Without it: an in-memory store that resets on restart.
//   GEMINI_API_KEY   with GEMINI_MODEL: the real extractor. Without them: the MOCK answer-key extractor.

export interface RuntimeInfo {
  store: "postgres" | "memory";
  extractor: "gemini" | "mock";
  extractorLabel: string;
  model: string | null;
  buyer: string;
}

export interface Runtime {
  deps: PipelineDeps;
  info: RuntimeInfo;
}

/** Calendar date in India (invoices and due dates are Indian business dates). */
export function todayIst(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/**
 * Demo seed profile (test matrix A13): DEMO_SENDER_V01 ... DEMO_SENDER_V06 add a real address you control to that
 * vendor's registered senders, so a live email from you passes K3. The S8 sender stays unregistered.
 */
export function withDemoSenders(ref: ReferenceData, env: Record<string, string | undefined> = process.env): ReferenceData {
  return {
    ...ref,
    vendors: ref.vendors.map((v) => {
      const extra = (env[`DEMO_SENDER_${v.vendor_id}`] ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
      return extra.length ? { ...v, registered_senders: [...v.registered_senders, ...extra.filter((x) => !v.registered_senders.includes(x))] } : v;
    }),
  };
}

function build(): Runtime {
  const reference: ReferenceData = withDemoSenders(loadReferenceData());
  const dbUrl = process.env.DATABASE_URL;
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || null;

  let store: RunStore;
  let pool: Pool | null = null;
  let pgStore: PgRunStore | null = null;
  if (dbUrl) {
    pool = new Pool({ connectionString: dbUrl, max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 });
    pgStore = new PgRunStore(pool);
    store = pgStore;
  } else {
    store = new MemoryRunStore();
  }

  let extractor: Extractor;
  let proposer: MappingProposer;
  if (key && model) {
    const transport = transportFromEnv(key);
    const cache = pool && pgStore ? new PgExtractionCache(pool, pgStore) : new MemoryExtractionCache();
    extractor = new GeminiExtractor({ model, transport, reference, cache });
    proposer = new GeminiMappingProposer({ model, transport, reference });
  } else {
    extractor = new AnswerKeyExtractor(reference);
    proposer = new AnswerKeyProposer();
  }

  const deps: PipelineDeps = {
    store, reference, extractor, proposer,
    today: () => todayIst(),
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
    newRef: nextRef,
  };
  return {
    deps,
    info: {
      store: dbUrl ? "postgres" : "memory",
      extractor: key && model ? "gemini" : "mock",
      extractorLabel: extractor.label,
      model,
      buyer: reference.settings.buyer.name,
    },
  };
}

const g = globalThis as unknown as { __ps1Runtime?: Runtime };

/** One runtime per server process (kept across hot reloads in development). */
export function runtime(): Runtime {
  g.__ps1Runtime ??= build();
  return g.__ps1Runtime;
}
