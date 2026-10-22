import { describe, expect, it } from "vitest";
import { availableActions, samePhone } from "@/domain/runs/queries";
import { overrideApprove } from "@/domain/runs/review";
import { detail } from "@/server/views";
import { called, deliver, makeDeps, masterPhone } from "./support/harness";

// Spec v1.4 row 9 (decision Q9): approving a bank, vendor or sender hold by exception needs the phone call that
// confirmed it, to the vendor-master number when there is one, and then a second, explicit confirmation.
// MOCK reader (answer key); the pipeline, review actions and store are the real code.

const DIVYA = { actor: "Divya (AP)", note: "Confirmed the new account with the vendor by phone" };
const CALL = { spoke_to: "Ravi, accounts", called_at: "2026-10-22T08:30:00.000Z" };

async function s2() {
  const deps = makeDeps();
  const run = await deliver(deps, "S2", {});
  expect(run.blocking_codes).toEqual(["BANK_DETAILS_CHANGED"]);
  return { deps, run, phone: masterPhone(run.vendor_id!) };
}

const eventsOf = async (deps: ReturnType<typeof makeDeps>, id: string) => (await deps.store.logs(id)).events;

describe("override of a changed bank account (S2)", () => {
  it("the override option says a callback is needed and gives the master number", async () => {
    const { deps, run, phone } = await s2();
    const ov = availableActions(run, { runs: new Map() }, deps.reference).find((a) => a.action === "override_approve")!;
    expect(ov.callback).toEqual({ codes: ["BANK_DETAILS_CHANGED"], master_phone: phone });
  });

  it("without a callback record it asks for one (not a refusal: nothing logged, nothing changed)", async () => {
    const { deps, run, phone } = await s2();
    const before = (await eventsOf(deps, run.run_id)).length;
    const r = await overrideApprove(deps, run.run_id, DIVYA);
    expect(r).toMatchObject({ ok: false, code: "NEEDS_CALLBACK", details: { master_phone: phone } });
    expect((await eventsOf(deps, run.run_id)).length).toBe(before);
    expect((await deps.store.read((s) => s.runs.get(run.run_id)))!.state).toBe("ON_HOLD");
  });

  it("a number that is not the vendor-master number is refused and logged", async () => {
    const { deps, run, phone } = await s2();
    const r = await overrideApprove(deps, run.run_id, { ...DIVYA, callback: { number_called: "+91 99000 11223", ...CALL }, confirmCallback: true });
    expect(r).toMatchObject({ ok: false, code: "INVALID_TRANSITION_BLOCKED" });
    if (!r.ok) expect(r.reason).toBe(`+91 99000 11223 is not the vendor-master number. Call ${phone}; never a number from the invoice or the email`);
    expect((await eventsOf(deps, run.run_id)).at(-1)).toMatchObject({ type: "INVALID_TRANSITION_BLOCKED" });
  });

  it("the master number asks for a second confirmation naming the account it would pay", async () => {
    const { deps, run, phone } = await s2();
    const r = await overrideApprove(deps, run.run_id, { ...DIVYA, callback: { number_called: phone, ...CALL } });
    expect(r).toMatchObject({ ok: false, code: "NEEDS_CONFIRMATION", details: { confirm: "callback" } });
    if (!r.ok) expect((r.details!.problems as string[])[0]).toMatch(/^Payment would go to the account ending 0091, not the vendor-master account ending 2290$/);
  });

  it("confirmed: approved, with the call on the approval record and in the audit log", async () => {
    const { deps, run, phone } = await s2();
    const typed = phone.replace(/^\+91\s*/, "0"); // the same number written the local way
    const r = await overrideApprove(deps, run.run_id, { ...DIVYA, callback: { number_called: typed, ...CALL }, confirmCallback: true });
    expect(r.ok && r.value.state).toBe("APPROVED");
    const logs = await deps.store.logs(run.run_id);
    expect(logs.approvals.at(-1)!.callback).toEqual({ number_called: typed, spoke_to: "Ravi, accounts", called_at: CALL.called_at, codes: ["BANK_DETAILS_CHANGED"], master_phone: phone });
    expect(logs.events.find((e) => e.to_state === "APPROVED")!.details).toMatchObject({ callback: { number_called: typed } });
    const state = await deps.store.read((st) => ({ runs: st.runs, documents: st.documents, tokens: st.tokens }));
    const slip = detail((await deps.store.read((st) => st.runs.get(run.run_id)))!, state, logs, deps.reference).stages.at(-1)!;
    expect(slip.notes[0].text).toBe(`Approved with an exception by Divya (AP) (demo identity). Call recorded: Ravi, accounts on ${typed}, 22 Oct, 14:00 (India time). Note: ${DIVYA.note}`);
  });

  it("a call time in the future or missing fields ask again", async () => {
    const { deps, run, phone } = await s2();
    const future = await overrideApprove(deps, run.run_id, { ...DIVYA, callback: { number_called: phone, spoke_to: "Ravi", called_at: "2027-01-01T10:00:00.000Z" }, confirmCallback: true });
    expect(future).toMatchObject({ ok: false, code: "NEEDS_CALLBACK", reason: "The time of the call is in the future" });
    const blank = await overrideApprove(deps, run.run_id, { ...DIVYA, callback: { number_called: phone, spoke_to: "  ", called_at: CALL.called_at }, confirmCallback: true });
    expect(blank).toMatchObject({ ok: false, code: "NEEDS_CALLBACK" });
  });
});

describe("other holds", () => {
  it("unknown vendor and unverified sender (S8): there is no master number, so any number is recorded as given", async () => {
    const deps = makeDeps();
    const run = await deliver(deps, "S8", {});
    const ask = await overrideApprove(deps, run.run_id, { ...DIVYA, note: "One-off supplier" });
    expect(ask).toMatchObject({ ok: false, code: "NEEDS_CALLBACK", details: { codes: ["VENDOR_UNKNOWN", "SENDER_UNVERIFIED"], master_phone: null } });
    const r = await overrideApprove(deps, run.run_id, { ...DIVYA, note: "One-off supplier", ...called("+91 98450 12345") });
    expect(r.ok).toBe(true);
    expect((await deps.store.logs(run.run_id)).approvals.at(-1)!.callback).toMatchObject({ number_called: "+91 98450 12345", master_phone: null });
  });

  it("a price hold (S3) needs no callback: the override is unchanged", async () => {
    const deps = makeDeps();
    const run = await deliver(deps, "S3", {});
    expect(availableActions(run, { runs: new Map() }, deps.reference).find((a) => a.action === "override_approve")!.callback).toBeUndefined();
    const r = await overrideApprove(deps, run.run_id, { ...DIVYA, note: "Price rise agreed" });
    expect(r.ok).toBe(true);
    expect((await deps.store.logs(run.run_id)).approvals.at(-1)!.callback).toBeUndefined();
  });
});

describe("samePhone", () => {
  it.each([
    ["+91 80 0000 1002", "080 0000 1002", true],
    ["+91-80-0000-1002", "8000001002", true],
    ["+91 80 0000 1003", "+91 80 0000 1002", false],
    ["1002", "+91 80 0000 1002", false],
  ])("%s vs %s -> %s", (a, b, same) => expect(samePhone(a, b)).toBe(same));
});
