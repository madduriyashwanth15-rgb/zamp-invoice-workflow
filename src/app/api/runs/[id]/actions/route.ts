import { guarded, json, refused } from "@/server/http";
import { act, type ActionBody } from "@/server/service";

export async function POST(request: Request, ctx: RouteContext<"/api/runs/[id]/actions">) {
  return guarded(async () => {
    const { id } = await ctx.params;
    const body = (await request.json()) as ActionBody;
    const r = await act(id, body);
    return r.ok ? json({ ok: true }) : refused(r);
  });
}
