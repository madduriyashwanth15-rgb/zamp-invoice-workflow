import { connection } from "next/server";
import { guarded } from "@/server/http";
import { auditCsv } from "@/server/service";
import { todayIst } from "@/server/runtime";
import { currentWorkspace } from "@/server/workspace";

// Gap 15: download the whole audit trail (every recorded event) as CSV. Read-only.
export async function GET() {
  await connection();
  return guarded(async () => {
    const csv = await auditCsv(await currentWorkspace());
    return new Response(csv, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="audit-log-${todayIst()}.csv"`, "Cache-Control": "no-store" },
    });
  });
}
