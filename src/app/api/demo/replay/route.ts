import { after, connection } from "next/server";
import { replay, scenarios } from "@/server/demo";
import { guarded, json } from "@/server/http";

export async function GET() {
  await connection();
  return guarded(async () => json(scenarios()));
}

/** Simulates the vendor sending a recorded test email; the intake and every check after it are real. */
export async function POST(request: Request) {
  return guarded(async () => {
    const { test_id } = (await request.json()) as { test_id: string };
    try {
      const r = await replay(test_id);
      for (const w of r.work) after(w);
      return json({ ok: true, run_ids: r.run_ids, repeats: r.repeats });
    } catch (e) {
      return json({ ok: false, code: "REPLAY_REFUSED", reason: e instanceof Error ? e.message : String(e) }, 409);
    }
  });
}
