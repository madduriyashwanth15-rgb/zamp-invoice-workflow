"use client";

import { useEffect, useId, useRef, type ComponentType, type ReactNode, type SVGProps } from "react";
import { CircleAlert, CircleCheck, Info, PencilLine, ShieldCheck, TriangleAlert, User, X } from "lucide-react";

// The desk's shared parts: buttons, panels, notices, dialogs, fields and provenance tags. One look everywhere,
// so the reviewer learns it once.

export type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number | string }>;

export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ");

// ---- buttons

type Variant = "primary" | "approve" | "secondary" | "danger" | "danger-solid" | "ghost";
type Size = "sm" | "md";

const VARIANT: Record<Variant, string> = {
  primary: "bg-carbon text-white hover:bg-carbon-deep border border-carbon hover:border-carbon-deep",
  approve: "bg-approved-bg text-approved-fg hover:bg-[#123d22] border border-approved-bg",
  secondary: "bg-surface text-ink border border-rule-strong hover:bg-surface-2 hover:border-ink-3",
  danger: "bg-surface text-bad-fg border border-bad-edge hover:bg-bad-bg",
  "danger-solid": "bg-bad-fg text-white border border-bad-fg hover:bg-[#771628]",
  ghost: "bg-transparent text-ink-2 border border-transparent hover:bg-muted-bg hover:text-ink",
};
const SIZE: Record<Size, string> = {
  sm: "h-8 px-2.5 text-[13px] gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
};

/** Class names for a button-looking element (a <button>, a link or a label). */
export function btn(variant: Variant = "secondary", size: Size = "md", extra?: string): string {
  return cx(
    "inline-flex shrink-0 items-center justify-center rounded-md font-semibold whitespace-nowrap transition-colors",
    "disabled:cursor-not-allowed disabled:opacity-45 aria-disabled:cursor-not-allowed aria-disabled:opacity-45",
    VARIANT[variant],
    SIZE[size],
    extra,
  );
}

export function Button({
  variant = "secondary",
  size = "md",
  icon: I,
  busy,
  children,
  className,
  type = "button",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; icon?: Icon; busy?: boolean }) {
  return (
    <button type={type} className={btn(variant, size, className)} aria-busy={busy || undefined} {...rest}>
      {I && <I aria-hidden size={size === "sm" ? 15 : 16} strokeWidth={2} />}
      {children}
    </button>
  );
}

// ---- panels

export function Panel({
  title,
  description,
  actions,
  children,
  id,
  className,
  flush,
  as: Tag = "section",
  headingLevel = 2,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
  className?: string;
  /** Body without padding (tables, lists that run edge to edge). */
  flush?: boolean;
  as?: "section" | "div";
  headingLevel?: 2 | 3;
}) {
  const autoId = useId();
  const hid = id ?? autoId;
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <Tag aria-labelledby={title ? hid : undefined} className={cx("rounded-lg border border-rule bg-surface", className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-rule px-4 py-3">
          <div className="min-w-0">
            {title && (
              <H id={hid} className="text-[15px] font-semibold text-ink">
                {title}
              </H>
            )}
            {description && <p className="mt-0.5 text-[13px] text-ink-2">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={flush ? "" : "px-4 py-3"}>{children}</div>
    </Tag>
  );
}

// ---- notices (never auto-dismissed)

type NoticeTone = "info" | "warn" | "error" | "success";
const NOTICE: Record<NoticeTone, { cls: string; icon: Icon }> = {
  info: { cls: "border-wait-edge bg-wait-bg text-wait-fg", icon: Info },
  warn: { cls: "border-hold-edge bg-hold-bg text-hold-fg", icon: TriangleAlert },
  error: { cls: "border-bad-edge bg-bad-bg text-bad-fg", icon: CircleAlert },
  success: { cls: "border-ok-edge bg-ok-bg text-ok-fg", icon: CircleCheck },
};

export function Notice({ tone = "info", title, children, className, live }: { tone?: NoticeTone; title?: ReactNode; children?: ReactNode; className?: string; live?: boolean }) {
  const { cls, icon: I } = NOTICE[tone];
  return (
    <div role={live ? (tone === "error" ? "alert" : "status") : undefined} className={cx("flex gap-2.5 rounded-md border px-3 py-2.5 text-[13px]", cls, className)}>
      <I aria-hidden size={16} className="mt-px shrink-0" />
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? "mt-0.5" : ""}>{children}</div>}
      </div>
    </div>
  );
}

// ---- dialog (native: focus stays inside, Escape closes, the page behind is inert)

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const autoId = useId();
  const hid = labelledBy ?? autoId;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={hid}
      className={cx("sheet", wide && "wide")}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-rule px-5 py-4">
            <div className="min-w-0">
              <h2 id={hid} className="text-[17px] font-semibold text-ink">
                {title}
              </h2>
              {description && <div className="mt-1 text-[13px] text-ink-2">{description}</div>}
            </div>
            <button type="button" onClick={onClose} className="-mt-1 -mr-2 rounded-md p-1.5 text-ink-3 hover:bg-muted-bg hover:text-ink" aria-label="Close">
              <X size={18} aria-hidden />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-rule bg-surface-2 px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

// ---- fields

export const inputCls =
  "block w-full rounded-md border border-rule-strong bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-3 focus:border-carbon focus:outline-none focus-visible:outline-2 focus-visible:outline-carbon disabled:bg-muted-bg";

export function Field({ label, hint, htmlFor, children, className }: { label: ReactNode; hint?: ReactNode; htmlFor?: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="block text-[13px] font-semibold text-ink">
        {label}
      </label>
      {hint && <p className="mt-0.5 text-[12px] text-ink-2">{hint}</p>}
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

// ---- provenance: who produced a value or a decision (AI reading, code check, person)

export type Source = "ai" | "mock" | "code" | "person";

const SOURCE: Record<Source, { label: string; icon: Icon; cls: string }> = {
  ai: { label: "Read by AI", icon: PencilLine, cls: "border-dashed border-graphite text-ink-2" },
  mock: { label: "MOCK reading", icon: PencilLine, cls: "border-dashed border-hold-edge text-hold-fg" },
  code: { label: "Code check", icon: ShieldCheck, cls: "border-rule-strong text-ink-2" },
  person: { label: "Reviewer", icon: User, cls: "border-carbon/40 text-carbon-deep" },
};

export function SourceTag({ source, label, className }: { source: Source; label?: string; className?: string }) {
  const s = SOURCE[source];
  const I = s.icon;
  return (
    <span className={cx("inline-flex items-center gap-1 rounded border bg-surface px-1.5 py-px text-[11px] font-medium whitespace-nowrap", s.cls, className)}>
      <I aria-hidden size={12} />
      {label ?? s.label}
    </span>
  );
}

// ---- small things

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cx("skeleton block h-3.5", className)} />;
}

export function EmptyState({ icon: I, title, children, action }: { icon?: Icon; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      {I && (
        <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted-bg text-ink-3">
          <I aria-hidden size={20} />
        </span>
      )}
      <p className="font-semibold text-ink">{title}</p>
      {children && <div className="mt-1 max-w-md text-[13px] text-ink-2">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** A label: value pair in a definition list. */
export function Fact({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx("min-w-0", className)}>
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd className="mt-0.5 break-words font-medium text-ink">{children}</dd>
    </div>
  );
}

/** Text shown when a value is absent, styled so it never reads as data. */
export function Absent({ children }: { children: ReactNode }) {
  return <span className="font-normal text-ink-3">{children}</span>;
}
