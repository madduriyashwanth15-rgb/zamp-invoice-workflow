import {
  BadgeCheck,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleX,
  Clock,
  Copy,
  Eye,
  FileExclamationPoint,
  FileSpreadsheet,
  LoaderCircle,
  Scale,
  ShieldAlert,
} from "lucide-react";
import type { Tone } from "@/lib/reason-text";
import { TIER_TEXT, type IssueTier } from "@/lib/issue-tier";
import type { RunState } from "@/domain/engine/types";
import type { Icon } from "./kit";

// Status labels. Cleared, approved and exported must never look alike (UI-2): each has its own colour, icon and
// word. Nothing here says paid: payment happens in finance's own process, after the export.

const TONE: Record<Tone, string> = {
  neutral: "bg-carbon-wash text-carbon-deep border-carbon-wash",
  muted: "bg-muted-bg text-muted-fg border-muted-edge",
  ok: "bg-ok-bg text-ok-fg border-ok-edge",
  hold: "bg-hold-bg text-hold-fg border-hold-edge",
  wait: "bg-wait-bg text-wait-fg border-wait-edge",
  approved: "bg-approved-bg text-approved-fg border-approved-bg",
  bad: "bg-bad-bg text-bad-fg border-bad-edge",
};

const TONE_ICON: Record<Tone, Icon> = {
  neutral: LoaderCircle,
  muted: CircleDashed,
  ok: CircleCheck,
  hold: CirclePause,
  wait: Clock,
  approved: BadgeCheck,
  bad: CircleX,
};

/** One or two words for tables; the full label stays in the accessible name. */
export const SHORT_STATE: Record<RunState, string> = {
  RECEIVED: "Received",
  PROCESSING: "Reading",
  SKIPPED: "Skipped",
  CLEARED: "Cleared",
  ON_HOLD: "On hold",
  AWAITING_VENDOR: "Waiting for vendor",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  SUPERSEDED: "Replaced",
  FAILED: "Not read",
};

export function StateChip({ tone, label, exported, short, size = "md" }: { tone: Tone; label: string; exported?: boolean; short?: string; size?: "sm" | "md" }) {
  const pad = size === "sm" ? "px-1.5 py-px text-[12px] gap-1" : "px-2 py-0.5 text-[13px] gap-1.5";
  if (exported) {
    return (
      <span
        title="Exported to a payment list for finance"
        className={`inline-flex items-center whitespace-nowrap rounded border border-carbon bg-carbon font-semibold text-white ${pad}`}
      >
        <FileSpreadsheet aria-hidden size={size === "sm" ? 12 : 14} />
        Exported
      </span>
    );
  }
  const I = TONE_ICON[tone];
  return (
    <span title={short ? label : undefined} className={`inline-flex items-center whitespace-nowrap rounded border font-semibold ${TONE[tone]} ${pad}`}>
      <I aria-hidden size={size === "sm" ? 12 : 14} className={tone === "neutral" ? "animate-spin [animation-duration:2s]" : ""} />
      {short ? (
        <>
          <span aria-hidden>{short}</span>
          <span className="sr-only">{label}</span>
        </>
      ) : (
        label
      )}
    </span>
  );
}

export const toneClasses = TONE;

// ---- risk tiers

const TIER_STYLE: Record<IssueTier, { cls: string; icon: Icon }> = {
  identity: { cls: "border-bad-edge bg-bad-bg text-bad-fg", icon: ShieldAlert },
  twice: { cls: "border-bad-edge bg-surface text-bad-fg", icon: Copy },
  po: { cls: "border-hold-edge bg-hold-bg text-hold-fg", icon: Scale },
  document: { cls: "border-muted-edge bg-muted-bg text-muted-fg", icon: FileExclamationPoint },
  check: { cls: "border-wait-edge bg-wait-bg text-wait-fg", icon: Eye },
};

/** The tier's icon on its own (decorative; the words beside it carry the meaning). */
export function TierIcon({ tier, size = 16, className }: { tier: IssueTier; size?: number; className?: string }) {
  const I = TIER_STYLE[tier].icon;
  return <I aria-hidden size={size} className={className} />;
}

export function TierBadge({ tier, short, className }: { tier: IssueTier; short?: boolean; className?: string }) {
  const s = TIER_STYLE[tier];
  const I = s.icon;
  return (
    <span
      title={TIER_TEXT[tier].why}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-px text-[12px] font-semibold ${s.cls} ${className ?? ""}`}
    >
      <I aria-hidden size={12} />
      {short ? TIER_TEXT[tier].short : TIER_TEXT[tier].label}
    </span>
  );
}

// ---- the routing slip in brief

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
    <span role="img" aria-label={`Routing slip. ${label}`} title={label} className="inline-flex items-center gap-[2px]">
      {slip.map((m, i) => (
        <span
          key={m.id}
          className={`block h-2 w-2.5 rounded-[2px] border ${MARK[m.status] ?? MARK.not_reached} ${m.ai ? "outline-1 outline-offset-1 outline-dashed outline-graphite" : ""} ${i === 1 || i === slip.length - 1 ? "ml-1" : ""}`}
        />
      ))}
    </span>
  );
}

/** One mark of the strip on its own, for the legend (decorative: the words beside it carry the meaning). */
export function SlipSwatch({ status }: { status: string }) {
  return <span aria-hidden className={`inline-block h-2 w-2.5 rounded-[2px] border align-[-1px] ${MARK[status] ?? MARK.not_reached}`} />;
}
