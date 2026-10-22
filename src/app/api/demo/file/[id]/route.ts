import { connection } from "next/server";
import { sampleFile } from "@/server/demo";
import { guarded, json } from "@/server/http";

/** Download a sample invoice (the attachment of a recorded test email), e.g. to email it to the AP inbox yourself. */
export async function GET(_request: Request, ctx: RouteContext<"/api/demo/file/[id]">) {
  await connection();
  return guarded(async () => {
    const { id } = await ctx.params;
    const f = sampleFile(id);
    if (!f) return json({ ok: false, code: "NOT_FOUND", reason: `No sample invoice ${id}` }, 404);
    return new Response(Buffer.from(f.bytes), {
      headers: {
        "Content-Type": f.content_type,
        "Content-Disposition": `attachment; filename="${f.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "")}"`,
        "Cache-Control": "public, max-age=3600",
      },
    });
  });
}
