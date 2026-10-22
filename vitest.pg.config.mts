import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.mjs";

// The whole suite on Postgres: every golden "fresh database" is its own schema in the TEST database (A13).
// Time limits are generous because Neon is a network hop away: a golden run is about 390 round trips (measured
// 22 Oct), so about 30 s at 60 ms per round trip. A test that is wrong fails on its assertions, not on time.
export default mergeConfig(base, defineConfig({ test: { env: { TEST_STORE: "pg" }, testTimeout: 300_000, hookTimeout: 300_000 } }));
