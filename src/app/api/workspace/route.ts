import { guarded, json } from "@/server/http";
import { switchWorkspace } from "@/server/workspace";
import { kindOf } from "@/server/workspace-id";

/** Switches the visitor between their private sandbox and the shared AP inbox (where real email arrives). */
export async function POST(request: Request) {
  return guarded(async () => {
    // JSON only: a cross-site HTML form cannot send it without a CORS preflight.
    const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") return json({ ok: false, code: "UNSUPPORTED_MEDIA_TYPE", reason: "Send the request as application/json" }, 415);
    const { use } = (await request.json().catch(() => ({}))) as { use?: string };
    if (use !== "main" && use !== "sandbox") return json({ ok: false, code: "BAD_REQUEST", reason: 'Choose "main" (the shared inbox) or "sandbox"' }, 400);
    const ws = await switchWorkspace(use);
    return json({ ok: true, workspace: { kind: kindOf(ws) } });
  });
}
