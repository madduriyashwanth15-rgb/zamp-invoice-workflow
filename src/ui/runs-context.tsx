"use client";

import { createContext, useContext, type ReactNode } from "react";
import { api, type Listing } from "./api";
import { usePoll } from "./use-poll";

// One poll of the invoice list for the whole app: the side navigation's counts, the desk and the review screen's
// queue position all read the same data, so they never disagree.

type Runs = { data: Listing | null; error: unknown; loading: boolean; refresh: () => Promise<Listing | null> };

const Ctx = createContext<Runs>({ data: null, error: null, loading: true, refresh: async () => null });

const busy = (l: Listing | null) => Boolean(l?.runs.some((r) => r.state === "RECEIVED" || r.state === "PROCESSING"));

export function RunsProvider({ children }: { children: ReactNode }) {
  // On the desk: every 5 s (2 s while anything is being read), so an emailed invoice shows up quickly. Elsewhere the
  // list only feeds counts and next/previous, so every 15 s is enough. (The path is read when the timer is set, in
  // the browser, so the layout stays static.)
  const poll = usePoll(api.list, (d) => (busy(d) ? 2000 : window.location.pathname === "/" ? 5000 : 15000));
  return <Ctx.Provider value={poll}>{children}</Ctx.Provider>;
}

export const useRuns = () => useContext(Ctx);
