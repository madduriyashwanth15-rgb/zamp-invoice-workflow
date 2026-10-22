// node scripts/list-gemini-models.mjs
// Lists the Gemini models your key can call, and so also checks the key works. The key is read from .env.local
// and never printed.
import { existsSync } from "node:fs";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error("GEMINI_API_KEY is empty in .env.local: paste the key after the = sign and save the file.");
  process.exit(1);
}
const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": key } });
if (!res.ok) {
  console.error(`Google answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
const { models = [] } = await res.json();
const usable = models.filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"));
for (const m of usable) console.log(`${m.name.replace(/^models\//, "").padEnd(42)} ${m.displayName ?? ""}`);
console.log(`\nThe key works: ${usable.length} models available.`);
console.log('Copy the newest name with "flash" in it (skip "lite", "image", "tts" and "live") and paste it after GEMINI_MODEL= in .env.local.');
