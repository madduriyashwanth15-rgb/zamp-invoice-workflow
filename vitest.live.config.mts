import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { localEnv } from "./vitest.env.mjs";

// Live extraction run (test matrix, plan phase E): real Gemini calls with GEMINI_API_KEY and GEMINI_MODEL from .env.local.
// Uses free-tier quota (about 4 calls per run), so it never runs as part of `npm test`.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { environment: "node", include: ["tests/live/**/*.test.ts"], env: localEnv(".env.local"), testTimeout: 180_000 },
});
