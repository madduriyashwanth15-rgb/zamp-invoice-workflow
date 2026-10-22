import type { ActionFailure } from "@/domain/runs/review";

// Small helpers for route handlers: consistent JSON shapes and status codes.

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function refused(f: ActionFailure): Response {
  const status = f.code === "IDENTITY_REQUIRED" ? 400 : 409;
  return json(f, status);
}

export async function guarded(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[api]", message);
    return json({ ok: false, code: "SERVER_ERROR", reason: message }, 500);
  }
}
