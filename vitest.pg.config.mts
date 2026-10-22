import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.mjs";

// The whole suite on Postgres: every golden "fresh database" is its own schema in the TEST database (A13).
export default mergeConfig(base, defineConfig({ test: { env: { TEST_STORE: "pg" }, testTimeout: 60_000, hookTimeout: 60_000 } }));
