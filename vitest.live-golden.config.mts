import { defineConfig, mergeConfig } from "vitest/config";
import live from "./vitest.live.config.mjs";

// Live golden run (all 18 test invoices, real Gemini). About 23 calls of the free-tier daily quota: run on request.
export default mergeConfig(live, defineConfig({ test: { include: ["tests/live-golden/**/*.test.ts"], testTimeout: 900_000 } }));
