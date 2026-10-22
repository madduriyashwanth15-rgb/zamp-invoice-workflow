import { connection } from "next/server";
import { guarded, json } from "@/server/http";
import { info } from "@/server/service";

export async function GET() {
  await connection();
  return guarded(async () => json(info()));
}
