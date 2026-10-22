import { guarded, json, refused } from "@/server/http";
import { act, type ActionBody } from "@/server/service";

// Reading a document with the model happens in this request's after() work (or inside it, for retry). Vercel
// Hobby allows 300 s per invocation; the extractor's time budget keeps a run inside that (gemini-extractor.ts).
export const maxDuration = 300;

export async function POST(request: Request, ctx: RouteContext<"/api/runs/[id]/actions">) {
  return guarded(async () => {
    const { id } = await ctx.params;
    const body = (await request.json()) as ActionBody;
    const r = await act(id, body);
    return r.ok ? json({ ok: true }) : refused(r);
  });
}
