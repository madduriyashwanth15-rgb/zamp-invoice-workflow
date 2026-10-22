import type { ReasonCode } from "../codes";
import type { RunState } from "../engine/types";
import type { AuditEvent, RunRecord, StoreState } from "./types";

// Spec section 11: the only allowed transitions. Everything else is refused and logged INVALID_TRANSITION_BLOCKED.

export interface TransitionRow {
  row: number;
  from: RunState[];
  to: RunState[];
  trigger: string;
  actor: "system" | "user";
  noteRequired: boolean;
}

export const TRANSITIONS: TransitionRow[] = [
  { row: 1, from: ["RECEIVED"], to: ["PROCESSING"], trigger: "start", actor: "system", noteRequired: false },
  { row: 2, from: ["PROCESSING"], to: ["SKIPPED", "CLEARED", "ON_HOLD", "REJECTED"], trigger: "decision", actor: "system", noteRequired: false },
  { row: 3, from: ["PROCESSING"], to: ["FAILED"], trigger: "error after retries", actor: "system", noteRequired: false },
  { row: 4, from: ["FAILED"], to: ["PROCESSING"], trigger: "retry, same run id", actor: "user", noteRequired: false },
  { row: 5, from: ["SKIPPED"], to: ["PROCESSING"], trigger: "process as invoice", actor: "user", noteRequired: true },
  { row: 6, from: ["CLEARED"], to: ["APPROVED"], trigger: "approve, individual or batch", actor: "user", noteRequired: false },
  { row: 7, from: ["CLEARED"], to: ["ON_HOLD"], trigger: "manual hold", actor: "user", noteRequired: true },
  { row: 8, from: ["CLEARED"], to: ["ON_HOLD"], trigger: "RELATED_INVOICE_DISPUTE (D3)", actor: "system", noteRequired: false },
  { row: 9, from: ["ON_HOLD"], to: ["APPROVED"], trigger: "override", actor: "user", noteRequired: true },
  { row: 10, from: ["ON_HOLD"], to: ["REJECTED"], trigger: "reject", actor: "user", noteRequired: true },
  { row: 11, from: ["ON_HOLD"], to: ["AWAITING_VENDOR"], trigger: "correction email sent or marked sent manually", actor: "user", noteRequired: false },
  { row: 12, from: ["AWAITING_VENDOR"], to: ["ON_HOLD"], trigger: "vendor reply held (D2)", actor: "system", noteRequired: false },
  { row: 13, from: ["AWAITING_VENDOR"], to: ["ON_HOLD"], trigger: "stop waiting", actor: "user", noteRequired: true },
  { row: 14, from: ["AWAITING_VENDOR"], to: ["APPROVED", "REJECTED"], trigger: "reviewer decision", actor: "user", noteRequired: true },
  { row: 15, from: ["ON_HOLD", "AWAITING_VENDOR"], to: ["SUPERSEDED"], trigger: "token-linked correction cleared", actor: "system", noteRequired: false },
  { row: 16, from: ["ON_HOLD", "AWAITING_VENDOR"], to: ["SUPERSEDED"], trigger: "reviewer confirms link", actor: "user", noteRequired: true },
  { row: 17, from: ["APPROVED"], to: ["SUPERSEDED"], trigger: "reviewer replaces the approved invoice", actor: "user", noteRequired: true },
];

export class TransitionRefused extends Error {
  constructor(
    readonly run_id: string,
    readonly from: RunState,
    readonly to: RunState,
    readonly reason: string,
  ) {
    super(`transition ${from} -> ${to} refused for ${run_id}: ${reason}`);
  }
}

export function findRow(row: number): TransitionRow {
  const t = TRANSITIONS.find((x) => x.row === row);
  if (!t) throw new Error(`unknown transition row ${row}`);
  return t;
}

export function pushEvent(tx: StoreState, e: Omit<AuditEvent, "seq">): AuditEvent {
  const ev = { ...e, seq: 0 }; // the store assigns the real sequence number at commit
  tx.events.push(ev);
  return ev;
}

/** Applies one row of the table, or throws TransitionRefused. Terminal states never leave (except row 17 before export). */
export function transition(
  tx: StoreState,
  run: RunRecord,
  rowNo: number,
  to: RunState,
  ctx: { actor: string; at: string; note?: string | null; code?: ReasonCode; details?: Record<string, unknown> },
): void {
  const row = findRow(rowNo);
  const from = run.state;
  if (!row.from.includes(from) || !row.to.includes(to)) throw new TransitionRefused(run.run_id, from, to, `row ${rowNo} does not allow ${from} -> ${to}`);
  if (row.actor === "system" && ctx.actor !== "system") throw new TransitionRefused(run.run_id, from, to, `row ${rowNo} is a system transition`);
  if (row.actor === "user" && ctx.actor === "system") throw new TransitionRefused(run.run_id, from, to, `row ${rowNo} needs a reviewer`);
  if (row.noteRequired && !(ctx.note ?? "").trim()) throw new TransitionRefused(run.run_id, from, to, `row ${rowNo} requires a note`);
  if (from === "APPROVED" && run.exported) throw new TransitionRefused(run.run_id, from, to, "an exported approval is final");
  run.state = to;
  run.version += 1;
  run.updated_at = ctx.at;
  pushEvent(tx, {
    run_id: run.run_id, type: "STATE_CHANGED", actor: ctx.actor, at: ctx.at, from_state: from, to_state: to, transition: rowNo,
    code: ctx.code, note: ctx.note ?? null, details: ctx.details,
  });
}
