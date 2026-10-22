import { createHash, timingSafeEqual } from "node:crypto";

// Guard for destructive demo tools (audit A07). With DEMO_ADMIN_KEY set, the caller must send it; without it, reset
// stays open only on the in-memory store (a throwaway local copy) and is off when a database is attached.
// The codes are HTTP refusal codes like NEEDS_CONFIRMATION, not reason codes from the spec.

export type DemoResetMode = "key" | "open" | "disabled";

export type AdminCheck = { ok: true } | { ok: false; status: 401 | 403; code: "ADMIN_KEY_REQUIRED" | "RESET_DISABLED"; reason: string };

export function demoResetMode(configured: string | undefined, store: "postgres" | "memory"): DemoResetMode {
  if (configured?.trim()) return "key";
  return store === "postgres" ? "disabled" : "open";
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

export function checkAdminKey(provided: string | null, opts: { configured: string | undefined; store: "postgres" | "memory" }): AdminCheck {
  const mode = demoResetMode(opts.configured, opts.store);
  if (mode === "open") return { ok: true };
  if (mode === "disabled") return { ok: false, status: 403, code: "RESET_DISABLED", reason: "Reset is turned off: DEMO_ADMIN_KEY is not set on this deployment" };
  // Equal-length SHA-256 digests, so the comparison is constant time and the key's length never leaks.
  if (!provided?.trim()) return { ok: false, status: 401, code: "ADMIN_KEY_REQUIRED", reason: "Enter the admin key to reset this deployment" };
  if (timingSafeEqual(digest(provided), digest(opts.configured!.trim()))) return { ok: true };
  return { ok: false, status: 401, code: "ADMIN_KEY_REQUIRED", reason: "That admin key is not correct; nothing was reset" };
}
