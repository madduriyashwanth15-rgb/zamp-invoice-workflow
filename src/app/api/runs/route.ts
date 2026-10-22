import { after, connection } from "next/server";
import { guarded, json } from "@/server/http";
import { listRuns, upload } from "@/server/service";

// Reading a document with the model happens in this request's after() work (or inside it, for retry). Vercel
// Hobby allows 300 s per invocation; the extractor's time budget keeps a run inside that (gemini-extractor.ts).
export const maxDuration = 300;

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
