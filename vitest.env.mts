import { existsSync, readFileSync } from "node:fs";

/** Reads KEY=value lines from local env files (git-ignored) without adding a dependency. Existing env vars win. */
export function localEnv(...files: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf-8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || line.trimStart().startsWith("#")) continue;
      out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  for (const k of Object.keys(out)) if (process.env[k] !== undefined) out[k] = process.env[k]!;
  return out;
}
