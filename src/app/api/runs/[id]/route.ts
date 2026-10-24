import { connection } from "next/server";
import { guarded, json } from "@/server/http";
import { getRun } from "@/server/service";
import { currentWorkspace } from "@/server/workspace";

export async function GET(_request: Request, ctx: RouteContext<"/api/runs/[id]">) {
  await connection();
  return guarded(async () => {
    const { id } = await ctx.params;
    const run = await getRun(id, await currentWorkspace());
    return run ? json(run) : json({ ok: false, code: "NOT_FOUND", reason: `No run ${id}` }, 404);
  });
}
