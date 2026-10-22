import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll } from "vitest";
import { PgRunStore } from "@/server/db/pg-store";

// Postgres for tests: TEST_STORE=pg with TEST_DATABASE_URL (the Neon *test* database, never the demo one, A13).
// Each store gets its own schema, so every golden "fresh database" really is one; schemas are dropped afterwards.

export const usePg = process.env.TEST_STORE === "pg";
let pool: Pool | null = null;
const schemas: string[] = [];

export function testPool(): Pool {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_STORE=pg needs TEST_DATABASE_URL");
  if (!pool) {
    pool = new Pool({ connectionString: url, max: 8 });
    pool.on("error", (e) => console.error(`postgres: idle connection closed (${e.message})`));
  }
  return pool;
}

export function freshPgStore(): PgRunStore {
  const name = `t_${process.pid}_${schemas.length}_${randomBytes(3).toString("hex")}`;
  schemas.push(name);
  return new PgRunStore(testPool(), name);
}

afterAll(async () => {
  if (!pool) return;
  for (const s of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => undefined);
  await pool.end();
  pool = null;
});
