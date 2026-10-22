"use client";

import { useEffect, useState } from "react";
import { api } from "./api";
import type { RuntimeInfo } from "@/server/runtime";

/** States plainly which parts of this deployment are real and which are mocked. */
export function SystemStrip() {
  const [info, setInfo] = useState<RuntimeInfo | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.status().then(setInfo, () => setFailed(true));
  }, []);
  if (failed) return <p className="text-xs text-bad-fg">The server is not answering. Lists and actions will not load until it does.</p>;
  if (!info) return <p className="text-xs text-ink-3">Checking the setup</p>;
  return (
    <p className="text-xs text-ink-3">
      <span>Reading: </span>
      <span className={info.extractor === "mock" ? "font-semibold text-hold-fg" : "text-ink-2"}>
        {info.extractor === "gemini" ? `Gemini ${info.model}` : "MOCK extractor (answer key, test files only)"}
      </span>
      <span className="mx-2 text-rule-strong">|</span>
      <span>Records: </span>
      <span className={info.store === "memory" ? "font-semibold text-hold-fg" : "text-ink-2"}>
        {info.store === "postgres" ? "Postgres" : "in memory, cleared on restart"}
      </span>
      <span className="mx-2 text-rule-strong">|</span>
      <span>Fictional test data</span>
    </p>
  );
}
