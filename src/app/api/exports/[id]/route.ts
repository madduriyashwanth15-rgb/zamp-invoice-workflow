import { connection } from "next/server";
import { guarded, json } from "@/server/http";
import { exportCsv } from "@/server/service";

export async function GET(_request: Request, ctx: RouteContext<"/api/exports/[id]">) {
  await connection();
  return guarded(async () => {
    const { id } = await ctx.params;
    const csv = await exportCsv(id);
    if (!csv) return json({ ok: false, code: "NOT_FOUND", reason: `No export ${id}` }, 404);
    return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${id}.csv"` } });
  });
}
