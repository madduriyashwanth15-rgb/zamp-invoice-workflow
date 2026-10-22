import { resetDemo } from "@/server/demo";
import { guarded, json } from "@/server/http";

export async function POST(request: Request) {
  return guarded(async () => {
    const { actor, confirm, forgetReadings } = (await request.json()) as { actor?: string; confirm?: string; forgetReadings?: boolean };
    if (!actor?.trim()) return json({ ok: false, code: "IDENTITY_REQUIRED", reason: "Select a display name first (demo identity, not authentication)" }, 400);
    if (confirm !== "RESET") return json({ ok: false, code: "NEEDS_CONFIRMATION", reason: "Type RESET to confirm" }, 409);
    const { forgotten } = await resetDemo({ forgetReadings: forgetReadings === true });
    console.info(`[demo] reset by ${actor} (demo identity)${forgotten != null ? `, ${forgotten} saved readings forgotten` : ""}`);
    return json({ ok: true, forgotten });
  });
}
