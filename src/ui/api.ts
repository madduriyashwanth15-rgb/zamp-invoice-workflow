"use client";

import type { RunDetail, RunSummary } from "@/server/views";
import type { RuntimeInfo } from "@/server/runtime";

// Browser-side calls to the API routes. Every refusal comes back with the domain's code and reason.

export type Refusal = { ok: false; code: string; reason: string; details?: { problems?: string[] } };
export type Listing = { runs: RunSummary[]; exports: { export_id: string; created_by: string; created_at: string; count: number }[] };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const body = await res.json().catch(() => ({ ok: false, code: "BAD_RESPONSE", reason: `The server answered ${res.status} without details` }));
  if (!res.ok) throw body as Refusal;
  return body as T;
}

const post = <T,>(url: string, data: unknown) => call<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

export const api = {
  list: () => call<Listing>("/api/runs"),
  run: (id: string) => call<RunDetail>(`/api/runs/${encodeURIComponent(id)}`),
  status: () => call<RuntimeInfo>("/api/status"),
  upload: (file: File, uploader: string) => {
    const fd = new FormData();
    fd.set("file", file);
    fd.set("uploader", uploader);
    return call<{ ok: true; run_id: string; repeat: boolean }>("/api/runs", { method: "POST", body: fd });
  },
  act: (id: string, body: Record<string, unknown>) => post<{ ok: true }>(`/api/runs/${encodeURIComponent(id)}/actions`, body),
  approveBatch: (runIds: string[], actor: string, expectedVersions: Record<string, number>) => post<{ ok: true; count: number }>("/api/approvals", { runIds, actor, expectedVersions }),
  exportNow: (actor: string) => post<{ ok: true; export_id: string; count: number }>("/api/exports", { actor }),
};

export function isRefusal(e: unknown): e is Refusal {
  return typeof e === "object" && e !== null && "code" in e && "reason" in e;
}

export function errorText(e: unknown): string {
  if (isRefusal(e)) return e.reason;
  if (e instanceof Error) return e.message.includes("fetch") ? "The server could not be reached. Check your connection and try again." : e.message;
  return "Something went wrong";
}
