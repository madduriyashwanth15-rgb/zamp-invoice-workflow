import type { Tone } from "@/lib/reason-text";

// Status chips. Cleared, approved and exported must never look alike (UI-2).

const TONE: Record<Tone, string> = {
  neutral: "bg-carbon-wash text-carbon-deep border-carbon-wash",
  muted: "bg-muted-bg text-muted-fg border-muted-edge",
  ok: "bg-ok-bg text-ok-fg border-ok-edge",
  hold: "bg-hold-bg text-hold-fg border-hold-edge",
  wait: "bg-wait-bg text-wait-fg border-wait-edge",
  approved: "bg-approved-bg text-approved-fg border-approved-bg",
  bad: "bg-bad-bg text-bad-fg border-bad-edge",
};

export function StateChip({ tone, label, exported }: { tone: Tone; label: string; exported?: boolean }) {
  if (exported) {
    return <span className="inline-flex items-center whitespace-nowrap rounded-full border border-carbon bg-carbon px-2.5 py-0.5 text-sm font-semibold text-white">Exported</span>;
  }
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-sm font-semibold ${TONE[tone]}`}>{label}</span>;
}

export const toneClasses = TONE;
