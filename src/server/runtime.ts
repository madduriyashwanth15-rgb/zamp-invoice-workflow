import { randomBytes, randomUUID } from "node:crypto";
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
import { GeminiExtractor, GeminiMappingProposer, MemoryExtractionCache, type ExtractionCache } from "@/server/extractor/gemini-extractor";
import { transportFromEnv } from "@/server/extractor/gemini-transport";
import { ResendSender, type MailSender } from "@/server/correction-email";
import { demoResetMode, type DemoResetMode } from "@/server/admin-guard";
import { MAIN, isWorkspace, type Workspace, type WorkspaceKind } from "@/server/workspace-id";

// Wires the domain to real infrastructure from environment variables. Nothing here decides anything.
//   DATABASE_URL     Postgres (Neon demo database). Without it: an in-memory store that resets on restart.
//   GEMINI_API_KEY   with GEMINI_MODEL: the real extractor. Without them: the MOCK answer-key extractor.
//   GEMINI_FALLBACK_MODEL  optional backup model for attempts after the main model is overloaded or times out.
//   RESEND_API_KEY + AP_INBOX_ADDRESS  correction emails are sent by the app, with replies to the AP inbox.
//                    RESEND_FROM sets the sender (default: Resend's test sender, which on the free plan without a
//                    verified domain only delivers to the Resend account's own address). Without them: manual only.
//   DEMO_ADMIN_KEY   required to reset demo data. Without it: reset is open in memory and off with a database.

export interface RuntimeInfo {
  store: "postgres" | "memory";
  extractor: "gemini" | "mock";
  extractorLabel: string;
  model: string | null;
  /** Backup model, if configured (GEMINI_FALLBACK_MODEL). */
  fallbackModel: string | null;
  buyer: string;
  /** How correction emails leave: sent by the app, or copied and marked sent manually. */
  correctionEmail: { mode: "send"; from: string; reply_to: string } | { mode: "manual" };
  /** How /demo reset is guarded (admin-guard.ts). The key itself is never exposed. */
  demoReset: DemoResetMode;
  /**
   * Which workspace this answer is for (set per request by the status route): the shared AP inbox, where real email
   * arrives, or the visitor's private sandbox. `ap_inbox` is the real inbox address, when one is configured.
   */
  workspace?: { kind: WorkspaceKind; ap_inbox: string | null };
}

export interface Runtime {
  /** The shared AP inbox ("main"): real email, the demo's history. */
  deps: PipelineDeps;
  /** The wiring for one workspace: main is `deps` itself; a sandbox gets its own store over the same database. */
  depsFor: (ws: Workspace) => PipelineDeps;
  /** In-memory store only: forgets every sandbox (a reset of the shared inbox empties every workspace). */
  forgetSandboxes: () => void;
  info: RuntimeInfo;
  /** Present when the app sends correction emails itself. */
  mail: { sender: MailSender; replyTo: string } | null;
  /** Saved readings of the real reader; null with the MOCK extractor (it reads nothing, so nothing is saved). */
  cache: ExtractionCache | null;
}

export const DEFAULT_RESEND_FROM = "SpiceRoute AP (demo) <onboarding@resend.dev>";

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
  const fallbackModel = process.env.GEMINI_FALLBACK_MODEL || null;

  let store: RunStore;
  let pool: Pool | null = null;
  let pgStore: PgRunStore | null = null;
  if (dbUrl) {
    pool = new Pool({ connectionString: dbUrl, max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 });
    // An idle connection dropped by the server (Neon suspends after 5 idle minutes) is reported here; without a
    // listener node-postgres would crash the process. The pool replaces the connection on the next query.
    pool.on("error", (e) => console.error(`postgres: idle connection closed (${e.message})`));
    pgStore = new PgRunStore(pool);
    store = pgStore;
  } else {
    store = new MemoryRunStore();
  }

  let extractor: Extractor;
  let proposer: MappingProposer;
  let cache: ExtractionCache | null = null;
  if (key && model) {
    const transport = transportFromEnv(key);
    cache = pool && pgStore ? new PgExtractionCache(pool, pgStore) : new MemoryExtractionCache();
    extractor = new GeminiExtractor({ model, fallbackModel, transport, reference, cache });
    proposer = new GeminiMappingProposer({ model, fallbackModel, transport, reference });
  } else {
    extractor = new AnswerKeyExtractor(reference);
    proposer = new AnswerKeyProposer();
  }

  const resendKey = process.env.RESEND_API_KEY;
  const inbox = (process.env.AP_INBOX_ADDRESS ?? "").trim();
  const mail = resendKey && inbox ? { sender: new ResendSender(resendKey, process.env.RESEND_FROM || DEFAULT_RESEND_FROM), replyTo: inbox } : null;

  const deps: PipelineDeps = {
    store, reference, extractor, proposer,
    today: () => todayIst(),
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
    newSecret: () => randomBytes(16).toString("hex"),
    newRef: nextRef,
  };
  // A sandbox shares everything with the shared inbox except its store: on Postgres a store bound to the sandbox's
  // rows (schema setup is shared, so a new sandbox costs no DDL); in memory a store of its own.
  const sandboxes = new Map<Workspace, PipelineDeps>();
  const rt: Runtime = {
    deps,
    depsFor: (ws) => {
      if (!isWorkspace(ws)) throw new Error(`invalid workspace ${ws}`);
      if (ws === MAIN) return rt.deps;
      let d = sandboxes.get(ws);
      if (!d) {
        d = { ...rt.deps, store: pool ? new PgRunStore(pool, "public", ws) : new MemoryRunStore() };
        sandboxes.set(ws, d);
      }
      return d;
    },
    forgetSandboxes: () => sandboxes.clear(),
    mail,
    cache,
    info: {
      store: dbUrl ? "postgres" : "memory",
      extractor: key && model ? "gemini" : "mock",
      extractorLabel: extractor.label,
      model,
      fallbackModel: key && model ? fallbackModel : null,
      buyer: reference.settings.buyer.name,
      correctionEmail: mail ? { mode: "send", from: mail.sender.from, reply_to: mail.replyTo } : { mode: "manual" },
      demoReset: demoResetMode(process.env.DEMO_ADMIN_KEY, dbUrl ? "postgres" : "memory"),
    },
  };
  return rt;
}

const g = globalThis as unknown as { __ps1Runtime?: Runtime };

/** One runtime per server process (kept across hot reloads in development). */
export function runtime(): Runtime {
  g.__ps1Runtime ??= build();
  return g.__ps1Runtime;
}
