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
    exclude: ["tests/live/**", "node_modules/**"],
    env: localEnv(".env.test.local"),
    hookTimeout: 60_000,
  },
});
