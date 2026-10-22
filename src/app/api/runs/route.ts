import { after, connection } from "next/server";
import { guarded, json } from "@/server/http";
import { listRuns, upload } from "@/server/service";

export async function GET() {
  await connection();
  return guarded(async () => json(await listRuns()));
}

/** Upload one invoice file. Responds as soon as the run is recorded; reading and checks continue after the response. */
export async function POST(request: Request) {
  return guarded(async () => {
    const form = await request.formData();
    const file = form.get("file");
    const uploader = String(form.get("uploader") ?? "").trim();
    if (!uploader) return json({ ok: false, code: "IDENTITY_REQUIRED", reason: "Select a display name first (demo identity, not authentication)" }, 400);
    if (!(file instanceof File) || file.size === 0) return json({ ok: false, code: "NO_FILE", reason: "Choose a PDF, PNG or JPEG file to upload" }, 400);
    const r = await upload(file, uploader);
    if (r.process) after(r.process);
    return json({ ok: true, run_id: r.run_id, repeat: r.repeat }, r.repeat ? 200 : 201);
  });
}
