import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { localEnv } from "./vitest.env.mjs";

// Default run: in-memory store, MOCK providers, no network. Postgres-only checks run when TEST_DATABASE_URL is set
// (in .env.test.local); `npm run test:pg` runs the whole suite on Postgres; `npm run test:live` calls the real Gemini API.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/live/**", "tests/live-golden/**", "node_modules/**"],
    env: localEnv(".env.test.local"),
    hookTimeout: 60_000,
    testTimeout: 30_000, // a golden run is about 1-3 s on a laptop; the default 5 s left no margin
  },
});
