"use client";

import { createContext, useContext, useEffect, useId, useState, type ReactNode } from "react";
import { UserRound } from "lucide-react";

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

/** Who is acting, chosen in the side navigation. On the dark spine by default. */
export function IdentityPicker({ onLight }: { onLight?: boolean }) {
  const { name, setName } = useIdentity();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const showInput = editing || (name !== "" && !PRESETS.includes(name));
  const field = onLight ? "border-rule-strong bg-surface text-ink" : "border-spine-2 bg-spine-2 text-white focus:border-spine-ink-2";
  return (
    <div>
      <label htmlFor={id} className={`flex items-center gap-1.5 text-[12px] font-semibold ${onLight ? "text-ink-2" : "text-spine-ink"}`}>
        <UserRound aria-hidden size={13} />
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
        className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-[13px] ${name ? field : "border-hold-edge bg-hold-bg font-semibold text-hold-fg"}`}
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
          className={`mt-1.5 block w-full rounded-md border px-2 py-1.5 text-[13px] ${field}`}
          placeholder="Your display name"
        />
      )}
      <p className={`mt-1 text-[11px] ${onLight ? "text-ink-3" : "text-spine-ink-2"}`}>{IDENTITY_LABEL}</p>
    </div>
  );
}
