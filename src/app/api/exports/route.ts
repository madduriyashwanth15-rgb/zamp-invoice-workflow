import { guarded, json, refused } from "@/server/http";
import { exportNow } from "@/server/service";

/** Export every APPROVED, unexported, unblocked run to a new payment list (an event, not a state). */
export async function POST(request: Request) {
  return guarded(async () => {
    const body = (await request.json()) as { actor: string };
    const r = await exportNow(body.actor ?? "");
    return r.ok ? json(r) : refused(r);
  });
}
