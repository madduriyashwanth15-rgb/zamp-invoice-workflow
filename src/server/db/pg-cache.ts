import type { Pool } from "pg";
import type { Extraction } from "@/domain/extraction-schema";
import type { ExtractionCache } from "@/server/extractor/gemini-extractor";
import type { PgRunStore } from "./pg-store";

/** Extraction cache in Postgres (spec 14: sha256 + prompt version + model). Survives deploys and demo resets. */
export class PgExtractionCache implements ExtractionCache {
  constructor(private pool: Pool, private store: PgRunStore, private schema = "public") {}

  async get(key: string): Promise<Extraction | null> {
    await this.store.ensureSchema();
    const r = await this.pool.query<{ data: Extraction }>(`SELECT data FROM "${this.schema}".extraction_cache WHERE cache_key = $1`, [key]);
    return r.rows[0]?.data ?? null;
  }

  async set(key: string, value: Extraction): Promise<void> {
    await this.store.ensureSchema();
    await this.pool.query(
      `INSERT INTO "${this.schema}".extraction_cache (cache_key, data) VALUES ($1, $2::jsonb) ON CONFLICT (cache_key) DO UPDATE SET data = EXCLUDED.data`,
      [key, JSON.stringify(value)],
    );
  }
}
