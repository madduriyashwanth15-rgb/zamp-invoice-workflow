import Decimal from "decimal.js";
import { exceedsCap, paiseToRupees } from "../money";
import type { ReferenceData } from "../engine/types";
import { markCorrectionSent } from "./actions";
import { processRun, type PipelineDeps } from "./pipeline";
import { pushEvent, transition, TransitionRefused } from "./state-machine";
import type { Approval, ExportRecord, RunRecord, StoreState } from "./types";

// Reviewer actions (spec 11-13). Every action needs a demo display name (U1, T13); every refusal is logged
// INVALID_TRANSITION_BLOCKED with its reason; a stale or repeated action is a logged no-op (ACTION_REPEAT_IGNORED, T8).

export type ActionFailure = {
  ok: false;
  code: "INVALID_TRANSITION_BLOCKED" | "ACTION_REPEAT_IGNORED" | "IDENTITY_REQUIRED" | "NEEDS_CONFIRMATION";
  reason: string;
  details?: Record<string, unknown>;
};
export type ActionResult<T> = { ok: true; value: T } | ActionFailure;

export interface ActionCtx {
  /** Self-selected demo display name ("Demo identity — not authentication"). */
  actor: string;
  note?: string | null;
  /** The run version the reviewer was looking at; a mismatch means the click is stale or repeated. */
  expectedVersion?: number;
}

type Deps = Pick<PipelineDeps, "store" | "now" | "newId" | "reference">;

class Refusal extends Error {
  constructor(readonly code: ActionFailure["code"], readonly reason: string, readonly details?: Record<string, unknown>) {
    super(reason);
  }
}

const PAYABLE = new Set(["CLEARED", "APPROVED"]);

function guardIdentity(actor: string) {
  const a = (actor ?? "").trim();
  if (!a || a.toLowerCase() === "system") throw new Refusal("IDENTITY_REQUIRED", "Select a display name first (demo identity, not authentication)");
}

function getRun(tx: StoreState, runId: string, ctx: ActionCtx): RunRecord {
  const run = tx.runs.get(runId);
  if (!run) throw new Refusal("INVALID_TRANSITION_BLOCKED", `unknown run ${runId}`);
  if (ctx.expectedVersion != null && ctx.expectedVersion !== run.version) {
    throw new Refusal("ACTION_REPEAT_IGNORED", `run ${run.ref} changed since it was shown (version ${ctx.expectedVersion} -> ${run.version})`);
  }
  return run;
}

/** Runs `fn` in one transaction; on refusal nothing changes and the refusal itself is logged in a separate transaction. */
async function act<T>(deps: Deps, runIds: string[], ctx: ActionCtx, action: string, fn: (tx: StoreState) => T): Promise<ActionResult<T>> {
  try {
    guardIdentity(ctx.actor);
    return { ok: true, value: await deps.store.transaction(fn) };
  } catch (e) {
    const failure: ActionFailure =
      e instanceof Refusal ? { ok: false, code: e.code, reason: e.reason, details: e.details }
        : e instanceof TransitionRefused ? { ok: false, code: "INVALID_TRANSITION_BLOCKED", reason: e.reason }
          : (() => { throw e; })();
    if (failure.code !== "IDENTITY_REQUIRED" && failure.code !== "NEEDS_CONFIRMATION") {
      await deps.store.transaction((tx) => {
        for (const id of runIds.length ? runIds : [null]) {
          pushEvent(tx, {
            run_id: id, type: failure.code === "ACTION_REPEAT_IGNORED" ? "ACTION_REPEAT_IGNORED" : "INVALID_TRANSITION_BLOCKED",
            actor: ctx.actor, at: deps.now(), note: ctx.note ?? null, details: { action, reason: failure.reason },
          });
        }
      });
    }
    return failure;
  }
}

function chainHasOtherPayable(tx: StoreState, run: RunRecord): RunRecord | undefined {
  if (!run.chain_key) return undefined;
  return [...tx.runs.values()].find((r) => r.run_id !== run.run_id && r.chain_key === run.chain_key && PAYABLE.has(r.state));
}

function recordApproval(tx: StoreState, run: RunRecord, a: Omit<Approval, "run_id">) {
  tx.approvals.push({ run_id: run.run_id, ...a });
}

/** C2/C3 against what other CLEARED and APPROVED runs already consume (spec C4: override approvals re-run C2/C3). */
export function recheckConsumption(tx: StoreState, run: RunRecord, ref: ReferenceData): string[] {
  const problems: string[] = [];
  const s = ref.settings;
  const pos = [...new Set(run.consumption.map((c) => c.po_number))];
  for (const poNumber of pos) {
    const po = ref.purchaseOrders.find((p) => p.po_number === poNumber)!;
    let others = 0n;
    const otherQty = new Map<number, Decimal>();
    for (const r of tx.runs.values()) {
      if (r.run_id === run.run_id || !PAYABLE.has(r.state)) continue;
      for (const c of r.consumption) {
        if (c.po_number !== poNumber) continue;
        others += c.amount_paise;
        otherQty.set(c.line_no, (otherQty.get(c.line_no) ?? new Decimal(0)).plus(c.base_qty));
      }
    }
    let mine = 0n;
    for (const c of run.consumption.filter((x) => x.po_number === poNumber)) {
      mine += c.amount_paise;
      const pl = po.lines.find((l) => l.line_no === c.line_no);
      if (!pl) continue; // line 0: PO-level amount of a lump-sum line, no quantity to check
      const cap = new Decimal(pl.qty_ordered).mul(new Decimal(100).plus(s.quantity_tolerance_pct)).div(100);
      const total = new Decimal(c.base_qty).plus(otherQty.get(c.line_no) ?? 0);
      if (total.gt(cap)) problems.push(`C2 ${poNumber} line ${c.line_no}: ${total} would be billed against ${pl.qty_ordered} ordered`);
    }
    if (exceedsCap(mine + others, po.subtotal_pretax, s.price_tolerance_pct)) {
      problems.push(`C3 ${poNumber}: ${paiseToRupees(mine + others)} would be billed against ${paiseToRupees(po.subtotal_pretax)} (+${s.price_tolerance_pct}%)`);
    }
  }
  return problems;
}

/** Row 6: approve CLEARED runs, individually or as one batch (all or nothing). */
export function approve(deps: Deps, runIds: string[], ctx: ActionCtx & { expectedVersions?: Record<string, number> }): Promise<ActionResult<RunRecord[]>> {
  return act(deps, runIds, ctx, runIds.length > 1 ? "approve (batch)" : "approve", (tx) => {
    const at = deps.now();
    const batchId = runIds.length > 1 ? `B-${deps.newId()}` : null;
    return runIds.map((id) => {
      const run = getRun(tx, id, { ...ctx, expectedVersion: ctx.expectedVersions?.[id] ?? ctx.expectedVersion });
      if (run.export_blocked) throw new Refusal("INVALID_TRANSITION_BLOCKED", `${run.ref} is export-blocked (${run.export_block_reason})`);
      const other = chainHasOtherPayable(tx, run);
      if (other) throw new Refusal("INVALID_TRANSITION_BLOCKED", `CHAIN_INVARIANT: ${other.ref} is already ${other.state} for this invoice number`);
      transition(tx, run, 6, "APPROVED", { actor: ctx.actor, at, details: { mode: batchId ? "batch" : "individual", batch_id: batchId } });
      recordApproval(tx, run, { approver_display_name: ctx.actor, approved_at: at, mode: batchId ? "batch" : "individual", batch_id: batchId, note: null });
      return run;
    });
  });
}

/** Rows 9 and 14: approve a held run by override. C2/C3 re-run; failing them needs a second confirmation. Never supersedes. */
export function overrideApprove(deps: Deps, runId: string, ctx: ActionCtx & { confirmFailingChecks?: boolean }): Promise<ActionResult<RunRecord>> {
  return act(deps, [runId], ctx, "override approve", (tx) => {
    const run = getRun(tx, runId, ctx);
    if (run.engine?.dispute?.counterpart_exported) {
      throw new Refusal("INVALID_TRANSITION_BLOCKED", "Its counterpart in this invoice number is already exported: this needs the company's credit-note process; reject or keep on hold");
    }
    const other = chainHasOtherPayable(tx, run);
    if (other) throw new Refusal("INVALID_TRANSITION_BLOCKED", `CHAIN_INVARIANT: ${other.ref} is already ${other.state} for this invoice number`);
    const problems = recheckConsumption(tx, run, deps.reference);
    if (problems.length && !ctx.confirmFailingChecks) {
      throw new Refusal("NEEDS_CONFIRMATION", "Approving this would exceed the PO; confirm again to approve anyway", { problems });
    }
    const at = deps.now();
    const row = run.state === "AWAITING_VENDOR" ? 14 : 9;
    transition(tx, run, row, "APPROVED", { actor: ctx.actor, at, note: ctx.note, details: { overridden: run.blocking_codes, c2c3: problems, confirmed: Boolean(ctx.confirmFailingChecks) } });
    recordApproval(tx, run, { approver_display_name: ctx.actor, approved_at: at, mode: "override", batch_id: null, note: ctx.note ?? null });
    return run;
  });
}

/** Rows 10 and 14: reject. Rejecting the newer run of a D3 dispute lifts the original's export block (A8, T15). */
export function reject(deps: Deps, runId: string, ctx: ActionCtx): Promise<ActionResult<RunRecord>> {
  return act(deps, [runId], ctx, "reject", (tx) => {
    const run = getRun(tx, runId, ctx);
    const at = deps.now();
    transition(tx, run, run.state === "AWAITING_VENDOR" ? 14 : 10, "REJECTED", { actor: ctx.actor, at, note: ctx.note });
    const d = run.engine?.dispute;
    if (d) {
      const counterpart = tx.runs.get(d.counterpart_run_id);
      const stillDisputed = [...tx.runs.values()].some((r) => r.run_id !== run.run_id && (r.state === "ON_HOLD" || r.state === "AWAITING_VENDOR") && r.engine?.dispute?.counterpart_run_id === d.counterpart_run_id);
      if (counterpart?.export_blocked && counterpart.export_block_reason === "RELATED_INVOICE_DISPUTE" && !stillDisputed) {
        counterpart.export_blocked = false;
        counterpart.export_block_reason = null;
        counterpart.version += 1;
        pushEvent(tx, { run_id: counterpart.run_id, type: "NOTE", actor: ctx.actor, at, details: { export_block_lifted: true, because_rejected: run.run_id } });
      }
    }
    return run;
  });
}

/** Row 7: put a CLEARED run on hold manually (code MANUAL_HOLD; its consumption stops counting). */
export function manualHold(deps: Deps, runId: string, ctx: ActionCtx): Promise<ActionResult<RunRecord>> {
  return act(deps, [runId], ctx, "manual hold", (tx) => {
    const run = getRun(tx, runId, ctx);
    transition(tx, run, 7, "ON_HOLD", { actor: ctx.actor, at: deps.now(), note: ctx.note, code: "MANUAL_HOLD" });
    if (!run.blocking_codes.includes("MANUAL_HOLD")) run.blocking_codes.unshift("MANUAL_HOLD");
    run.primary_reason = "MANUAL_HOLD";
    return run;
  });
}

/** Row 13: stop waiting for the vendor. */
export function stopWaiting(deps: Deps, runId: string, ctx: ActionCtx): Promise<ActionResult<RunRecord>> {
  return act(deps, [runId], ctx, "stop waiting", (tx) => {
    const run = getRun(tx, runId, ctx);
    transition(tx, run, 13, "ON_HOLD", { actor: ctx.actor, at: deps.now(), note: ctx.note });
    return run;
  });
}

/** Row 11: correction email sent or marked sent manually; issues the token. */
export async function requestCorrection(deps: Deps, runId: string, ctx: ActionCtx & { channel?: "sent" | "marked sent manually" }): Promise<ActionResult<{ run: RunRecord; token: string }>> {
  try {
    guardIdentity(ctx.actor);
    const value = await markCorrectionSent(deps, runId, ctx.actor, ctx.channel ?? "sent", (tx) => { getRun(tx, runId, ctx); });
    return { ok: true, value };
  } catch (e) {
    return act(deps, [runId], ctx, "request correction", () => { throw e; });
  }
}

/**
 * Row 16: reviewer confirms an unlinked correction whose only blocking code is CORRECTION_UNCONFIRMED. Like an
 * override it approves, so C2/C3 are re-run against what is already billed and failing them needs a second confirmation.
 */
export function confirmCorrectionLink(deps: Deps, candidateId: string, ctx: ActionCtx & { confirmFailingChecks?: boolean }): Promise<ActionResult<RunRecord>> {
  return act(deps, [candidateId], ctx, "confirm correction link", (tx) => {
    const cand = getRun(tx, candidateId, ctx);
    if (cand.state !== "ON_HOLD" || cand.blocking_codes.length !== 1 || cand.blocking_codes[0] !== "CORRECTION_UNCONFIRMED") {
      throw new Refusal("INVALID_TRANSITION_BLOCKED", `Link confirmation needs CORRECTION_UNCONFIRMED as the only blocking code (has: ${cand.blocking_codes.join(", ") || "none"})`);
    }
    const at = deps.now();
    const originals = (cand.engine?.correction?.hold_family_run_ids ?? []).map((id) => tx.runs.get(id)!).filter((r) => r.state === "ON_HOLD" || r.state === "AWAITING_VENDOR");
    if (originals.length === 0) {
      throw new Refusal("INVALID_TRANSITION_BLOCKED", "No held invoice is left for this to replace (the earlier ones were rejected or replaced); approve it with an exception instead");
    }
    for (const o of originals) {
      transition(tx, o, 16, "SUPERSEDED", { actor: ctx.actor, at, note: ctx.note, details: { superseded_by: cand.run_id } });
      o.superseded_by_run_id = cand.run_id;
      cand.supersedes_run_ids.push(o.run_id);
    }
    const other = chainHasOtherPayable(tx, cand);
    if (other) throw new Refusal("INVALID_TRANSITION_BLOCKED", `CHAIN_INVARIANT: ${other.ref} is already ${other.state}`);
    const problems = recheckConsumption(tx, cand, deps.reference);
    if (problems.length && !ctx.confirmFailingChecks) {
      throw new Refusal("NEEDS_CONFIRMATION", "Approving this would exceed the PO; confirm again to approve anyway", { problems });
    }
    transition(tx, cand, 9, "APPROVED", { actor: ctx.actor, at, note: ctx.note, details: { mode: "link-confirmation", supersedes: cand.supersedes_run_ids, c2c3: problems, confirmed: Boolean(ctx.confirmFailingChecks) } });
    recordApproval(tx, cand, { approver_display_name: ctx.actor, approved_at: at, mode: "link-confirmation", batch_id: null, note: ctx.note ?? null });
    return cand;
  });
}

/** Row 17: replace an APPROVED, unexported invoice by a candidate whose only blocking code is POSSIBLE_DOUBLE_BILLING.
 * C2/C3 are re-run without the replaced invoice; failing them needs a second confirmation. */
export function replaceApproved(deps: Deps, candidateId: string, ctx: ActionCtx & { confirmFailingChecks?: boolean }): Promise<ActionResult<RunRecord>> {
  return act(deps, [candidateId], ctx, "replace approved invoice", (tx) => {
    const cand = getRun(tx, candidateId, ctx);
    const d = cand.engine?.dispute;
    if (cand.state !== "ON_HOLD" || cand.blocking_codes.length !== 1 || cand.blocking_codes[0] !== "POSSIBLE_DOUBLE_BILLING" || !d) {
      throw new Refusal("INVALID_TRANSITION_BLOCKED", `Replacement needs POSSIBLE_DOUBLE_BILLING as the only blocking code (has: ${cand.blocking_codes.join(", ") || "none"})`);
    }
    const original = tx.runs.get(d.counterpart_run_id)!;
    if (original.state !== "APPROVED" || original.exported) {
      throw new Refusal("INVALID_TRANSITION_BLOCKED", `Only an APPROVED, unexported invoice can be replaced (${original.ref} is ${original.state}${original.exported ? ", exported" : ""})`);
    }
    const at = deps.now();
    transition(tx, original, 17, "SUPERSEDED", { actor: ctx.actor, at, note: ctx.note, details: { replaced_by: cand.run_id } });
    original.superseded_by_run_id = cand.run_id;
    original.export_blocked = false;
    original.export_block_reason = null;
    cand.supersedes_run_ids.push(original.run_id);
    const problems = recheckConsumption(tx, cand, deps.reference);
    if (problems.length && !ctx.confirmFailingChecks) {
      throw new Refusal("NEEDS_CONFIRMATION", "Approving this would exceed the PO; confirm again to approve anyway", { problems });
    }
    transition(tx, cand, 9, "APPROVED", { actor: ctx.actor, at, note: ctx.note, details: { mode: "replacement", replaces: original.run_id, c2c3: problems, confirmed: Boolean(ctx.confirmFailingChecks) } });
    recordApproval(tx, cand, { approver_display_name: ctx.actor, approved_at: at, mode: "replacement", batch_id: null, note: ctx.note ?? null });
    return cand;
  });
}

/** Export (event, not state): every APPROVED, unexported, not export-blocked run. Re-export is impossible. */
export function exportApproved(deps: Deps, ctx: ActionCtx): Promise<ActionResult<{ record: ExportRecord; runs: RunRecord[] }>> {
  return act(deps, [], ctx, "export", (tx) => {
    const eligible = [...tx.runs.values()].filter((r) => r.state === "APPROVED" && !r.exported && !r.export_blocked);
    if (eligible.length === 0) throw new Refusal("INVALID_TRANSITION_BLOCKED", "Nothing to export: no approved, unexported, unblocked invoices");
    const at = deps.now();
    const record: ExportRecord = { export_id: `EXP-${deps.newId()}`, created_by_display_name: ctx.actor, created_at: at, run_ids: eligible.map((r) => r.run_id) };
    tx.exports.push(record);
    for (const r of eligible) {
      r.exported = true;
      r.export_id = record.export_id;
      r.version += 1;
      r.updated_at = at;
      pushEvent(tx, { run_id: r.run_id, type: "EXPORTED", actor: ctx.actor, at, details: { export_id: record.export_id } });
    }
    return { record, runs: eligible };
  });
}

/** Row 4: retry a FAILED run with the same run id (the extractor cache makes it cheap). */
export async function retry(deps: PipelineDeps, runId: string, ctx: ActionCtx): Promise<ActionResult<RunRecord>> {
  const r = await act(deps, [runId], ctx, "retry", (tx) => {
    const run = getRun(tx, runId, ctx);
    if (!tx.documents.has(runId)) throw new Refusal("INVALID_TRANSITION_BLOCKED", `${run.ref} has no stored file to read again; the vendor has to send it again`);
    transition(tx, run, 4, "PROCESSING", { actor: ctx.actor, at: deps.now() });
    return run;
  });
  if (!r.ok) return r;
  return { ok: true, value: await processRun(deps, runId) };
}

/** Row 5: process a SKIPPED document as an invoice: G1 is bypassed for this run, every other check runs. */
export async function processAsInvoice(deps: PipelineDeps, runId: string, ctx: ActionCtx): Promise<ActionResult<RunRecord>> {
  const r = await act(deps, [runId], ctx, "process as invoice", (tx) => {
    const run = getRun(tx, runId, ctx);
    transition(tx, run, 5, "PROCESSING", { actor: ctx.actor, at: deps.now(), note: ctx.note });
    run.g1_bypassed = true;
    run.blocking_codes = [];
    run.primary_reason = null;
    return run;
  });
  if (!r.ok) return r;
  return { ok: true, value: await processRun(deps, runId) };
}

/** Reads for the UI and tests. */
export const approvalsOf = async (deps: Pick<PipelineDeps, "store">, runId: string) => (await deps.store.logs(runId)).approvals;
export const eventsOf = async (deps: Pick<PipelineDeps, "store">, runId: string) => (await deps.store.logs(runId)).events;
