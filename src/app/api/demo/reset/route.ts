import { checkAdminKey } from "@/server/admin-guard";
import { resetDemo } from "@/server/demo";
import { guarded, json } from "@/server/http";
import { runtime } from "@/server/runtime";

export async function POST(request: Request) {
  return guarded(async () => {
    // JSON only: a cross-site HTML form cannot send it without a CORS preflight.
    const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") {
      console.warn("[demo] reset refused: UNSUPPORTED_MEDIA_TYPE");
      return json({ ok: false, code: "UNSUPPORTED_MEDIA_TYPE", reason: "Send the request as application/json" }, 415);
    }
    const guard = checkAdminKey(request.headers.get("x-demo-admin-key"), { configured: process.env.DEMO_ADMIN_KEY, store: runtime().info.store });
    if (!guard.ok) {
      console.warn(`[demo] reset refused: ${guard.code}`);
      return json({ ok: false, code: guard.code, reason: guard.reason }, guard.status);
    }
    const { actor, confirm, forgetReadings } = (await request.json()) as { actor?: string; confirm?: string; forgetReadings?: boolean };
    if (!actor?.trim()) return json({ ok: false, code: "IDENTITY_REQUIRED", reason: "Select a display name first (demo identity, not authentication)" }, 400);
    if (confirm !== "RESET") return json({ ok: false, code: "NEEDS_CONFIRMATION", reason: "Type RESET to confirm" }, 409);
    const { forgotten } = await resetDemo({ forgetReadings: forgetReadings === true });
    console.info(`[demo] reset by ${actor} (demo identity)${forgotten != null ? `, ${forgotten} saved readings forgotten` : ""}`);
    return json({ ok: true, forgotten });
  });
}
