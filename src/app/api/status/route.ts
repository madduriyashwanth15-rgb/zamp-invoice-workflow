import { connection } from "next/server";
import { guarded, json } from "@/server/http";
import { info } from "@/server/service";
import { currentWorkspace } from "@/server/workspace";

export async function GET() {
  await connection();
  return guarded(async () => json(info(await currentWorkspace())));
}
