import { guarded, json, refused } from "@/server/http";
import { approveBatch } from "@/server/service";
import { currentWorkspace } from "@/server/workspace";

/** Batch approval of CLEARED runs (row 6): all or nothing. */
export async function POST(request: Request) {
  return guarded(async () => {
    const body = (await request.json()) as { runIds: string[]; actor: string; expectedVersions?: Record<string, number> };
    const r = await approveBatch(body.runIds ?? [], body.actor ?? "", body.expectedVersions, await currentWorkspace());
    return r.ok ? json({ ok: true, count: r.value.length }) : refused(r);
  });
}
