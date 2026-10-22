import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { localEnv } from "./vitest.env.mjs";

// Live golden run (all 18 test invoices, real Gemini): about 21 calls of the free-tier daily quota, so on request only.
// Standalone (not merged with the live config) so that it runs only this file.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { environment: "node", include: ["tests/live-golden/**/*.test.ts"], env: localEnv(".env.local"), testTimeout: 900_000 },
});
