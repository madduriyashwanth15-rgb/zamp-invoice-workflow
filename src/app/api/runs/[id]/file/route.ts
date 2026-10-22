import { connection } from "next/server";
import { guarded, json } from "@/server/http";
import { documentFile } from "@/server/service";

export async function GET(_request: Request, ctx: RouteContext<"/api/runs/[id]/file">) {
  await connection();
  return guarded(async () => {
    const { id } = await ctx.params;
    const f = await documentFile(id);
    if (!f) return json({ ok: false, code: "NOT_FOUND", reason: "No stored file for this run" }, 404);
    return new Response(Buffer.from(f.bytes), {
      headers: {
        "Content-Type": f.content_type,
        // ASCII fallback plus RFC 5987 for names outside Latin-1 (a raw non-ASCII header value would throw).
        "Content-Disposition": `inline; filename="${f.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "")}"; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
        "Cache-Control": "private, max-age=300",
      },
    });
  });
}
