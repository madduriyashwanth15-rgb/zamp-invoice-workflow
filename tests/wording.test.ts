import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// T7 / spec 12: the product never shows "Paid", "Payment authorised" or "Final approval", and never claims anything
// is or will be paid. Scans every user-facing source file (comments excluded).

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css)$/.test(f) ? [p] : [];
  });
}

const sources = [...files("src/ui"), ...files("src/app"), "src/lib/reason-text.ts", "src/server/views.ts"];
const code = (text: string) => text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("UI wording (spec 12)", () => {
  it.each(sources)("%s has no payment claims", (file) => {
    const text = code(readFileSync(file, "utf-8"));
    expect(text).not.toMatch(/\bpaid\b/i);
    expect(text).not.toMatch(/payment authori[sz]ed/i);
    expect(text).not.toMatch(/final approval/i);
  });
  it("the demo identity label is shown where a name is chosen", () => {
    expect(readFileSync("src/ui/identity.tsx", "utf-8")).toContain("Demo identity — not authentication");
  });
  it("the due date is labelled per terms", () => {
    expect(readFileSync("src/ui/run-view.tsx", "utf-8")).toContain("Due (per terms)");
  });
});
