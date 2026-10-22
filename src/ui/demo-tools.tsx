"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, errorText } from "./api";
import { useIdentity } from "./identity";

type Scenario = { test_id: string; title: string; file: string; sender: string; needs_token_of: string | null };

export function DemoTools() {
  const { name } = useIdentity();
  const [list, setList] = useState<Scenario[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, { ok: boolean; text: string; runId?: string }>>({});
  const [confirm, setConfirm] = useState("");
  const [resetMsg, setResetMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [inbox, setInbox] = useState<string | null>(null);

  useEffect(() => {
    api.status().then((i) => setInbox(i.correctionEmail.mode === "send" ? i.correctionEmail.reply_to : null), () => setInbox(null));
  }, []);

  useEffect(() => {
    fetch("/api/demo/replay", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`The server answered ${r.status}`))))
      .then(setList, (e) => setLoadError(errorText(e)));
  }, []);

  async function send(s: Scenario) {
    setResult((r) => ({ ...r, [s.test_id]: { ok: true, text: "Sending" } }));
    const res = await fetch("/api/demo/replay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ test_id: s.test_id }) });
    const body = await res.json().catch(() => ({ reason: `The server answered ${res.status}` }));
    setResult((r) => ({
      ...r,
      [s.test_id]: res.ok ? { ok: true, text: body.repeats?.length ? "Already received" : "Received", runId: body.run_ids?.[0] } : { ok: false, text: body.reason },
    }));
  }

  async function reset() {
    const res = await fetch("/api/demo/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actor: name, confirm }) });
    const body = await res.json().catch(() => ({}));
    setResetMsg(res.ok ? { ok: true, text: "All invoices and history were removed." } : { ok: false, text: body.reason ?? `The server answered ${res.status}` });
    if (res.ok) {
      setResult({});
      setConfirm("");
    }
  }

  return (
    <div className="space-y-8">
      <section aria-labelledby="replay-h" className="rounded-md border border-rule bg-surface">
        <div className="border-b border-rule px-4 py-3">
          <h1 id="replay-h" className="text-2xl font-bold tracking-tight">Send a recorded vendor email</h1>
          <p className="mt-1 max-w-3xl text-sm text-ink-2">
            Each button replays one recorded test email exactly as a vendor sent it (sender, subject, body and attachment).
            The email provider is simulated; the intake, reading, checks and decision are the real ones. Replies to a
            correction carry the reference this app actually issued.
          </p>
          <p className="mt-2 max-w-3xl text-sm text-ink-2">
            To try real email instead, download a sample invoice and email it as an attachment
            {inbox ? (
              <>
                {" "}to <span className="font-semibold text-ink">{inbox}</span>
              </>
            ) : (
              " to the AP inbox"
            )}
            . From an address that is not registered for that vendor it is held as an unverified sender, which is the
            intended check.
          </p>
        </div>
        {loadError && <p className="px-4 py-6 text-bad-fg">{loadError}</p>}
        {!list && !loadError && <p className="px-4 py-6 text-ink-2">Loading the recorded emails</p>}
        {list && (
          <ul className="divide-y divide-rule">
            {list.map((s) => {
              const r = result[s.test_id];
              return (
                <li key={s.test_id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="font-semibold">
                      <span className="num mr-2 text-ink-3">{s.test_id}</span>
                      {s.title}
                    </p>
                    <p className="text-xs text-ink-3">
                      {s.file}, from {s.sender === "unregistered" ? "an unregistered" : "a registered"} address{s.needs_token_of ? `, replies to the ${s.needs_token_of} correction request` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {r && (
                      <span role="status" className={`text-sm ${r.ok ? "text-ok-fg" : "text-bad-fg"}`}>
                        {r.text}
                        {r.runId && (
                          <>
                            {" "}
                            <Link href={`/runs/${r.runId}`} className="text-carbon-deep underline">
                              open
                            </Link>
                          </>
                        )}
                      </span>
                    )}
                    <a
                      href={`/api/demo/file/${encodeURIComponent(s.test_id)}`}
                      download
                      className="text-sm font-semibold text-carbon-deep underline underline-offset-2"
                    >
                      Download PDF<span className="sr-only"> for {s.test_id}</span>
                    </a>
                    <button type="button" onClick={() => send(s)} className="rounded-md border border-rule-strong px-3 py-1.5 text-sm font-semibold hover:bg-paper">
                      Send
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="reset-h" className="rounded-md border border-bad-edge bg-surface p-4">
        <h2 id="reset-h" className="text-lg font-bold">Start again</h2>
        <p className="mt-1 text-sm text-ink-2">Removes every invoice, approval, export and history entry. Saved readings are kept, so the same files read instantly.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label htmlFor="confirm" className="text-sm">
            Type RESET to confirm
          </label>
          <input id="confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="w-28 rounded-md border border-rule-strong px-2 py-1 text-sm" />
          <button type="button" disabled={confirm !== "RESET"} onClick={reset} className="rounded-md bg-bad-fg px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40">
            Remove everything
          </button>
        </div>
        {resetMsg && <p className={`mt-2 text-sm ${resetMsg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{resetMsg.text}</p>}
      </section>
    </div>
  );
}
