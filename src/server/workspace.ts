import { cookies, headers } from "next/headers";
import { MAIN, SB_COOKIE, WS_COOKIE, isSandbox, isWorkspace, newSandbox, type Workspace } from "@/server/workspace-id";

// The visitor's workspace, from two cookies (route handlers only):
//   ps1-ws  the workspace in use: "main" (the shared AP inbox) or the visitor's sandbox id
//   ps1-sb  the visitor's own sandbox id, kept while they look at the shared inbox so they can come back to it
// A request without a valid ps1-ws gets the visitor's sandbox (a new one when they have none), so by default every
// visitor works in a private sandbox and never sees anyone else's invoices. The id only scopes demo data: it is not
// a login and grants nothing beyond that sandbox.

const MAX_AGE = 30 * 24 * 60 * 60;

async function remember(ws: Workspace, sandbox: Workspace): Promise<void> {
  const jar = await cookies();
  const secure = (await headers()).get("x-forwarded-proto") === "https";
  const opts = { httpOnly: true, sameSite: "lax" as const, secure, path: "/", maxAge: MAX_AGE };
  jar.set(WS_COOKIE, ws, opts);
  jar.set(SB_COOKIE, sandbox, opts);
}

/** The visitor's own sandbox: the remembered one, or a new one. */
async function ownSandbox(): Promise<Workspace> {
  const sb = (await cookies()).get(SB_COOKIE)?.value;
  return isSandbox(sb) ? sb : newSandbox();
}

/** The workspace this request works in; sets the cookies when the visitor has none yet. */
export async function currentWorkspace(): Promise<Workspace> {
  const jar = await cookies();
  const ws = jar.get(WS_COOKIE)?.value;
  if (isWorkspace(ws)) {
    if (!isSandbox(jar.get(SB_COOKIE)?.value)) await remember(ws, ws === MAIN ? newSandbox() : ws);
    return ws;
  }
  const sb = await ownSandbox();
  await remember(sb, sb);
  return sb;
}

/** Switches the visitor to the shared inbox or back to their own sandbox. */
export async function switchWorkspace(target: "main" | "sandbox"): Promise<Workspace> {
  const sb = await ownSandbox();
  const ws = target === "main" ? MAIN : sb;
  await remember(ws, sb);
  return ws;
}

/** "Start again" in a sandbox: a new, empty sandbox. Nothing is deleted; the old one is simply left behind. */
export async function startNewSandbox(): Promise<Workspace> {
  const sb = newSandbox();
  await remember(sb, sb);
  return sb;
}
