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

type Mark = { id: string; title: string; status: string; ai: boolean };

const MARK: Record<string, string> = {
  passed: "bg-stamp-ok border-stamp-ok",
  held: "bg-hold-edge border-hold-fg/40",
  rejected: "bg-bad-fg border-bad-fg",
  skipped: "bg-muted-edge border-muted-edge",
  not_reached: "bg-transparent border-rule-strong border-dashed",
  running: "bg-carbon border-carbon slip-running",
  waiting: "bg-surface border-carbon",
  done: "bg-approved-bg border-approved-bg",
};

/** Where the invoice stands on its routing slip, in words (the strip's accessible name and tooltip). */
export function slipSummary(slip: Mark[]): string {
  const stop = slip.find((m) => m.status === "held" || m.status === "rejected" || m.status === "skipped");
  if (stop) return `${stop.status === "held" ? "Held at" : stop.status === "rejected" ? "Stopped at" : "Skipped at"}: ${stop.title}`;
  if (slip.some((m) => m.status === "running")) return "Being read";
  const review = slip.at(-1);
  if (review?.status === "done") return "Checked and decided by a reviewer";
  if (review?.status === "waiting") return "Every check passed; waiting for a reviewer";
  return "Not checked";
}

/**
 * The routing slip in brief: reading, the eight checks, then the reviewer, as one mark each. Pencil (dashed) for an
 * AI reading; the gaps separate who did the work (reader, code, person).
 */
export function SlipStrip({ slip }: { slip: Mark[] }) {
  const label = slipSummary(slip);
  return (
    <span role="img" aria-label={`Routing slip. ${label}`} title={label} className="inline-flex items-center gap-[3px]">
      {slip.map((m, i) => (
        <span
          key={m.id}
          className={`block h-2.5 w-3 rounded-[2px] border ${MARK[m.status] ?? MARK.not_reached} ${m.ai ? "outline-1 outline-offset-1 outline-dashed outline-graphite" : ""} ${i === 1 || i === slip.length - 1 ? "ml-1.5" : ""}`}
        />
      ))}
    </span>
  );
}

/** One mark of the strip on its own, for the legend (decorative: the words beside it carry the meaning). */
export function SlipSwatch({ status }: { status: string }) {
  return <span aria-hidden className={`inline-block h-2.5 w-3 rounded-[2px] border align-[-1px] ${MARK[status] ?? MARK.not_reached}`} />;
}
