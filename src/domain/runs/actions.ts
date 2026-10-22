import type { PipelineDeps } from "./pipeline";
import { pushEvent, transition } from "./state-machine";
import type { RunRecord, StoreState } from "./types";

// Reviewer actions that the pipeline itself depends on. The full action set (approve, override, reject,
// manual hold, stop waiting, link confirmation, replacement, export) lives in review.ts.

/**
 * The reply token for the next correction request on this run (A12): "R-<ref><4 characters>", a new one on each
 * request; earlier tokens stay valid for the same run. The suffix comes from the run id (random in the app), so a
 * token cannot be guessed from the visible reference alone.
 */
export function nextToken(tx: Pick<StoreState, "tokens">, run: RunRecord): string {
  const issued = [...tx.tokens.values()].filter((id) => id === run.run_id).length;
  let h = 0x811c9dc5;
  for (const ch of `${run.run_id}:${issued}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return `R-${run.ref}${h.toString(36).toUpperCase().padStart(4, "0").slice(-4)}`;
}

/** Row 11: correction email sent (or marked sent manually). Issues the reply token "[Ref R-<ref>]". */
export function markCorrectionSent(
  deps: Pick<PipelineDeps, "store" | "now">,
  runId: string,
  actor: string,
  channel: "sent" | "marked sent manually" = "sent",
  check?: (tx: StoreState, run: RunRecord) => void,
): Promise<{ run: RunRecord; token: string }> {
  return deps.store.transaction((tx) => {
    const run = tx.runs.get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    check?.(tx, run);
    const at = deps.now();
    const token = nextToken(tx, run);
    transition(tx, run, 11, "AWAITING_VENDOR", { actor, at, details: { token, channel } });
    tx.tokens.set(token, run.run_id);
    tx.corrections.push({ run_id: run.run_id, token, sent_at: at, channel });
    pushEvent(tx, { run_id: run.run_id, type: "CORRECTION_SENT", actor, at, details: { token, channel } });
    return { run, token };
  });
}
