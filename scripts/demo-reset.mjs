// npm run demo:reset: empties every run table in the DEMO database (DATABASE_URL in .env.local), keeping the
// extraction cache so re-sent files read instantly. Same effect as "Start again" on the /demo page.
import { existsSync } from "node:fs";
import pg from "pg";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (add it to .env.local). Without a database the app keeps records in memory: restart it to reset.");
  process.exit(1);
}
// Keep in step with RUN_TABLES in src/server/db/schema.ts.
const TABLES = ["audit_events", "approvals", "exports", "correction_requests", "reply_tokens", "documents", "deliveries", "runs"];
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const present = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)", [TABLES]);
  if (present.rowCount === 0) {
    console.log("No run tables yet: the app creates them on first use. Nothing to reset.");
  } else {
    const before = await client.query("SELECT count(*)::int AS n FROM runs").catch(() => ({ rows: [{ n: 0 }] }));
    await client.query(`TRUNCATE ${present.rows.map((r) => r.tablename).join(", ")} RESTART IDENTITY CASCADE`);
    console.log(`Demo database reset: removed ${before.rows[0].n} runs with their documents, approvals, exports and history. Extraction cache kept.`);
  }
} finally {
  await client.end();
}
