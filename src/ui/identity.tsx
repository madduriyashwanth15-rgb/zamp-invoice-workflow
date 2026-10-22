"use client";

import { createContext, useContext, useEffect, useId, useState, type ReactNode } from "react";

// U1: the reviewer picks a display name before acting. It is recorded on every action but never verified.

export const IDENTITY_LABEL = "Demo identity — not authentication";
const PRESETS = ["Divya (AP)", "Arjun (AP lead)", "Meera (Finance)"];
const KEY = "ps1.identity";

const Ctx = createContext<{ name: string; setName: (n: string) => void }>({ name: "", setName: () => {} });

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [name, setNameState] = useState("");
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reading a browser-only value after mount
      if (saved) setNameState(saved);
    } catch {
      /* storage unavailable: the name lives for this page only */
    }
  }, []);
  const setName = (n: string) => {
    setNameState(n);
    try {
      if (n) window.localStorage.setItem(KEY, n);
      else window.localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  };
  return <Ctx.Provider value={{ name, setName }}>{children}</Ctx.Provider>;
}

export const useIdentity = () => useContext(Ctx);

export function IdentityPicker() {
  const { name, setName } = useIdentity();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const showInput = editing || (name !== "" && !PRESETS.includes(name));
  return (
    <div className="flex flex-col items-end gap-0.5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <label htmlFor={id} className="text-sm text-ink-2">
          Acting as
        </label>
        <select
          id={id}
          value={showInput ? "__custom" : name}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "__custom") {
              setEditing(true);
              setName("");
            } else {
              setEditing(false);
              setName(v);
            }
          }}
          className={`rounded-md border px-2 py-1 text-sm ${name ? "border-rule-strong bg-surface text-ink" : "border-hold-edge bg-hold-bg text-hold-fg"}`}
        >
          <option value="">Choose a name</option>
          {PRESETS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
          <option value="__custom">Another name</option>
        </select>
        {showInput && (
          <input
            aria-label="Your display name"
            autoFocus={editing}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-40 rounded-md border border-rule-strong bg-surface px-2 py-1 text-sm"
            placeholder="Your display name"
          />
        )}
      </div>
      <span className="text-xs text-ink-3">{IDENTITY_LABEL}</span>
    </div>
  );
}
