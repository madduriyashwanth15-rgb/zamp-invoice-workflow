"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpRight, Download, Mail, RotateCcw, Send, TriangleAlert } from "lucide-react";
import type { RuntimeInfo } from "@/server/runtime";
import { api, errorText } from "./api";
import { useIdentity } from "./identity";
import { Button, Field, Notice, Panel, Skeleton, btn, cx, inputCls } from "./kit";
import { useRuns } from "./runs-context";
import { PageHeader } from "./shell";
import { openWorkspace } from "./system-strip";

type Scenario = { test_id: string; title: string; file: string; sender: string; needs_token_of: string | null };

export function DemoTools() {
  const { name } = useIdentity();
  const runs = useRuns();
  const [list, setList] = useState<Scenario[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, { ok: boolean; text: string; runId?: string; sending?: boolean }>>({});
  const [confirm, setConfirm] = useState("");
  const [forget, setForget] = useState(false);
  const [realReader, setRealReader] = useState(false);
  const [resetMode, setResetMode] = useState<RuntimeInfo["demoReset"]>("open");
  // Component state only: never stored in the browser, cleared after a successful reset.
  const [adminKey, setAdminKey] = useState("");
  const [resetMsg, setResetMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [resetting, setResetting] = useState(false);
  const [inbox, setInbox] = useState<string | null>(null);
  // A private sandbox (the default for each visitor) or the shared AP inbox, where real email arrives.
  const [sandbox, setSandbox] = useState(false);
  const [apInbox, setApInbox] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  useEffect(() => {
    api.status().then(
      (i) => {
        setInbox(i.correctionEmail.mode === "send" ? i.correctionEmail.reply_to : null);
        setRealReader(i.extractor === "gemini");
        setResetMode(i.demoReset);
        setSandbox(i.workspace?.kind === "sandbox");
        setApInbox(i.workspace?.ap_inbox ?? null);
      },
      () => setInbox(null),
    );
  }, []);

  useEffect(() => {
    fetch("/api/demo/replay", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`The server answered ${r.status}`))))
      .then(setList, (e) => setLoadError(errorText(e)));
  }, []);

  async function send(s: Scenario) {
    setResult((r) => ({ ...r, [s.test_id]: { ok: true, text: "Sending", sending: true } }));
    try {
      const res = await fetch("/api/demo/replay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ test_id: s.test_id }) });
      const body = await res.json().catch(() => ({ reason: `The server answered ${res.status}` }));
      setResult((r) => ({
        ...r,
        [s.test_id]: res.ok ? { ok: true, text: body.repeats?.length ? "Already received" : "Received", runId: body.run_ids?.[0] } : { ok: false, text: body.reason },
      }));
      runs.refresh();
    } catch (e) {
      setResult((r) => ({ ...r, [s.test_id]: { ok: false, text: errorText(e) } }));
    }
  }

  const showForget = realReader && resetMode !== "disabled" && !sandbox;

  async function newSandbox() {
    setResetting(true);
    try {
      const res = await fetch("/api/demo/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actor: name, confirm: "RESET" }) });
      const body = await res.json().catch(() => ({}));
      setResetMsg(res.ok ? { ok: true, text: "A new, empty sandbox is ready. The invoices you tried before are no longer shown." } : { ok: false, text: body.reason ?? `The server answered ${res.status}` });
      if (res.ok) {
        setResult({});
        runs.refresh();
      }
    } catch (e) {
      setResetMsg({ ok: false, text: errorText(e) });
    } finally {
      setResetting(false);
    }
  }

  async function reset() {
    setResetting(true);
    try {
      const res = await fetch("/api/demo/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(resetMode === "key" ? { "x-demo-admin-key": adminKey } : {}) },
        body: JSON.stringify({ actor: name, confirm, forgetReadings: forget }),
      });
      const body = await res.json().catch(() => ({}));
      const forgotten =
        typeof body.forgotten === "number"
          ? ` ${body.forgotten} saved reading${body.forgotten === 1 ? " was" : "s were"} forgotten: the next run of each file calls the AI again.`
          : "";
      setResetMsg(res.ok ? { ok: true, text: `All invoices and history were removed.${forgotten}` } : { ok: false, text: body.reason ?? `The server answered ${res.status}` });
      if (res.ok) {
        setResult({});
        setConfirm("");
        setForget(false);
        setAdminKey("");
        runs.refresh();
      }
    } catch (e) {
      setResetMsg({ ok: false, text: errorText(e) });
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Setup" }, { label: "Demo inbox" }]}
        title="Demo inbox"
        meta="Replays the recorded test emails exactly as a vendor sent them: sender, subject, body and attachment. The email provider is simulated; the intake, reading, checks and decision are the real ones, and replies to a correction carry the reference this app actually issued."
      />

      {sandbox ? (
        <Notice tone="info" title="You're in a private sandbox">
          Replays and uploads go only here, and nobody else sees them. Real emails to{" "}
          {apInbox ? <span className="font-semibold">{apInbox}</span> : "the AP inbox"} arrive in the shared inbox instead.{" "}
          <button
            type="button"
            onClick={async () => setSwitchError(await openWorkspace("main"))}
            className="font-semibold text-carbon-deep underline underline-offset-2"
          >
            Open the shared inbox
          </button>
          {switchError && <span className="block text-bad-fg">{switchError}</span>}
        </Notice>
      ) : (
        <Notice tone="info" title="Try a real email instead">
          Download a sample invoice and email it as an attachment
          {inbox ? (
            <>
              {" "}
              to <span className="font-semibold">{inbox}</span>
            </>
          ) : (
            " to the AP inbox"
          )}
          . From an address that is not registered for that vendor it is held as an unverified sender, which is the intended check.
        </Notice>
      )}

      <Panel
        title="Recorded vendor emails"
        description="S1 to S14 are the scenario set; X1 to X3 are extra edge cases. A reply to a correction needs that correction requested first."
        flush
      >
        {loadError && (
          <div className="p-4">
            <Notice tone="error" title="The recorded emails did not load">
              {loadError}
            </Notice>
          </div>
        )}
        {!list && !loadError && (
          <div aria-busy aria-label="Loading the recorded emails" className="space-y-3 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="w-2/3" />
            ))}
          </div>
        )}
        {list && (
          <ul className="divide-y divide-rule">
            {list.map((s) => {
              const r = result[s.test_id];
              return (
                <li key={s.test_id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
                  <span className="w-10 shrink-0 font-mono text-[12px] font-semibold text-ink-2">{s.test_id}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-ink">{s.title}</p>
                    <p className="flex flex-wrap items-center gap-x-2 text-[12px] text-ink-3">
                      <span className="break-all">{s.file}</span>
                      <span className={cx("inline-flex items-center gap-1", s.sender === "unregistered" && "font-medium text-bad-fg")}>
                        <Mail aria-hidden size={12} />
                        {s.sender === "unregistered" ? "unregistered sender" : "registered sender"}
                      </span>
                      {s.needs_token_of && <span>replies to the {s.needs_token_of} correction request</span>}
                    </p>
                  </div>
                  <div className="ml-14 flex items-center gap-2 sm:ml-0">
                    {r && (
                      <span role="status" className={cx("text-[12px] font-medium", r.sending ? "text-ink-2" : r.ok ? "text-ok-fg" : "text-bad-fg")}>
                        {r.text}
                        {r.runId && (
                          <Link href={`/runs/${r.runId}`} className="ml-1.5 inline-flex items-center gap-0.5 font-semibold text-carbon-deep hover:underline">
                            Open
                            <ArrowUpRight aria-hidden size={12} />
                          </Link>
                        )}
                      </span>
                    )}
                    <a href={`/api/demo/file/${encodeURIComponent(s.test_id)}`} download className={btn("ghost", "sm")}>
                      <Download aria-hidden size={14} />
                      PDF<span className="sr-only"> for {s.test_id}</span>
                    </a>
                    <Button size="sm" icon={Send} onClick={() => send(s)} disabled={r?.sending}>
                      Send<span className="sr-only"> {s.test_id}</span>
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {sandbox ? (
        <section aria-labelledby="restart-h" className="rounded-lg border border-rule bg-surface">
          <div className="border-b border-rule px-4 py-3">
            <h2 id="restart-h" className="text-[15px] font-semibold text-ink">
              Start again
            </h2>
            <p className="mt-0.5 text-[13px] text-ink-2">Opens a new, empty sandbox for you. Nothing is deleted: this sandbox is simply left behind.</p>
          </div>
          <div className="space-y-3 px-4 py-3">
            <Button icon={RotateCcw} busy={resetting} disabled={resetting} onClick={newSandbox}>
              {resetting ? "Opening" : "Start a new sandbox"}
            </Button>
            {resetMsg && (
              <Notice tone={resetMsg.ok ? "success" : "error"} live>
                {resetMsg.text}
              </Notice>
            )}
          </div>
        </section>
      ) : (
      <section aria-labelledby="reset-h" className="rounded-lg border border-bad-edge bg-surface">
        <div className="flex items-start gap-2 border-b border-bad-edge/60 px-4 py-3">
          <TriangleAlert aria-hidden size={16} className="mt-0.5 shrink-0 text-bad-fg" />
          <div>
            <h2 id="reset-h" className="text-[15px] font-semibold text-ink">
              Start again
            </h2>
            <p className="mt-0.5 text-[13px] text-ink-2">
              Removes every invoice, approval, export and history entry, in the shared inbox and in every private sandbox. This cannot be undone.
              {showForget && " Saved readings are kept unless you tick the box, so the same files read instantly."}
            </p>
          </div>
        </div>
        <div className="space-y-3 px-4 py-3">
          {resetMode === "disabled" && <p className="text-[13px] font-semibold">Reset is turned off on this deployment.</p>}
          {showForget && (
            <label className="flex items-start gap-2 text-[13px]">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-bad-fg" checked={forget} onChange={(e) => setForget(e.target.checked)} />
              <span>Also forget saved readings. The next run of each file is read by the AI again (uses AI quota, takes a few seconds per file).</span>
            </label>
          )}
          {resetMode !== "disabled" && (
            <div className="flex flex-wrap items-end gap-3">
              {resetMode === "key" && (
                <Field label="Admin key" htmlFor="admin-key" className="w-48">
                  <input id="admin-key" type="password" autoComplete="off" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} className={inputCls} />
                </Field>
              )}
              <Field label="Type RESET to confirm" htmlFor="confirm" className="w-40">
                <input id="confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={inputCls} autoComplete="off" />
              </Field>
              <Button variant="danger-solid" icon={RotateCcw} disabled={resetting || confirm !== "RESET" || (resetMode === "key" && !adminKey)} busy={resetting} onClick={reset}>
                {resetting ? "Removing" : "Remove everything"}
              </Button>
            </div>
          )}
          {resetMsg && (
            <Notice tone={resetMsg.ok ? "success" : "error"} live>
              {resetMsg.text}
            </Notice>
          )}
        </div>
      </section>
      )}
    </div>
  );
}
