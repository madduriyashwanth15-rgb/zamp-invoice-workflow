"use client";

import { useEffect, useState } from "react";
import { api } from "./api";
import type { RuntimeInfo } from "@/server/runtime";
import { modelName } from "@/lib/reader-label";

// States plainly which parts of this deployment are real and which are mocked.

let cached: Promise<RuntimeInfo> | null = null;

/** The deployment's setup (reader, records, email), loaded once per page load and shared. */
export function useRuntimeInfo(): { info: RuntimeInfo | null; failed: boolean } {
  const [info, setInfo] = useState<RuntimeInfo | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    cached ??= api.status().catch((e) => {
      cached = null;
      throw e;
    });
    cached.then(setInfo, () => setFailed(true));
  }, []);
  return { info, failed };
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${warn ? "bg-hold-edge" : "bg-stamp-ok"}`} aria-hidden />
      <span>
        <span className="text-spine-ink-2">{label}: </span>
        <span className={warn ? "font-semibold text-hold-edge" : "text-spine-ink"}>{value}</span>
      </span>
    </div>
  );
}

/**
 * Moves the visitor to the shared AP inbox or back to their own private sandbox, then opens the desk there (a full
 * load, so every list on the page is read again from the new workspace). Returns an error text, or null.
 */
export async function openWorkspace(use: "main" | "sandbox"): Promise<string | null> {
  try {
    const res = await fetch("/api/workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ use }) });
    if (!res.ok) return `The server answered ${res.status}; nothing changed`;
    // A full load on purpose: every list and the setup are read again, from the workspace now in use.
    window.location.assign(new URL("/", window.location.origin).href);
    return null;
  } catch {
    return "The server did not answer; nothing changed";
  }
}

function WorkspaceRow({ kind }: { kind: "shared" | "sandbox" }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shared = kind === "shared";
  return (
    <div>
      <Row label="Workspace" value={shared ? "shared AP inbox, real emails arrive here" : "private sandbox, only you see it"} />
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(await openWorkspace(shared ? "sandbox" : "main"));
          setBusy(false);
        }}
        className="mt-0.5 ml-3.5 text-left font-semibold text-spine-ink underline decoration-spine-ink-2 underline-offset-2 hover:text-white disabled:opacity-60"
      >
        {shared ? "Back to my sandbox" : "Open the shared inbox"}
      </button>
      {error && <p className="ml-3.5 text-bad-edge">{error}</p>}
    </div>
  );
}

/** The setup in brief, at the foot of the side navigation. */
export function SystemStrip() {
  const { info, failed } = useRuntimeInfo();
  if (failed) return <p className="text-[12px] font-semibold text-bad-edge">The server is not answering. Lists and actions will not load until it does.</p>;
  if (!info) return <p className="text-[12px] text-spine-ink-2">Checking the setup</p>;
  return (
    <div className="space-y-1 text-[12px] leading-snug">
      {info.workspace && <WorkspaceRow kind={info.workspace.kind} />}
      <Row
        label="Reader"
        warn={info.extractor === "mock"}
        value={info.extractor === "gemini" ? `${modelName(info.model ?? "")}${info.fallbackModel ? `, backup ${modelName(info.fallbackModel)}` : ""}` : "MOCK (answer key, test files only)"}
      />
      <Row label="Records" warn={info.store === "memory"} value={info.store === "postgres" ? "Postgres" : "in memory, cleared on restart"} />
      <Row
        label="Email"
        warn={info.correctionEmail.mode !== "send" && info.workspace?.kind !== "sandbox"}
        value={info.correctionEmail.mode === "send" ? "sends correction requests" : info.workspace?.kind === "sandbox" ? "copy and send by hand (a sandbox sends no email)" : "copy and send by hand"}
      />
      <p className="pl-3.5 text-spine-ink-2">Fictional test data</p>
    </div>
  );
}
