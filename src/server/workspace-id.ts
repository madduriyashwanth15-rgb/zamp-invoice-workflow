import { randomInt } from "node:crypto";

// Demo workspaces. "main" is the shared AP inbox: real email arrives there and its history is the demo's record.
// Every visitor also gets a private sandbox ("sb-" + 12 random characters), so each person can try the process from
// an empty desk without seeing anyone else's invoices. This file is the pure part (ids); the cookie handling for a
// request is in workspace.ts.

export const MAIN = "main";
export const WS_COOKIE = "ps1-ws";
export const SB_COOKIE = "ps1-sb";
export type Workspace = string;

const SANDBOX = /^sb-[a-z0-9]{12}$/;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export const isSandbox = (v: unknown): v is Workspace => typeof v === "string" && SANDBOX.test(v);
export const isWorkspace = (v: unknown): v is Workspace => v === MAIN || isSandbox(v);

/** A new sandbox id from cryptographic randomness (36^12, about 62 bits). */
export function newSandbox(): Workspace {
  let id = "sb-";
  for (let i = 0; i < 12; i++) id += ALPHABET[randomInt(ALPHABET.length)];
  return id;
}

export type WorkspaceKind = "shared" | "sandbox";
export const kindOf = (ws: Workspace): WorkspaceKind => (ws === MAIN ? "shared" : "sandbox");

/** The workspace named by a request's Cookie header (the ps1-ws cookie), or null when it names none or an invalid one. */
export function workspaceFromCookieHeader(header: string | null): Workspace | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== WS_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return isWorkspace(value) ? value : null;
  }
  return null;
}
