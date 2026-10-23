"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Archive, BadgeCheck, ChevronRight, CircleCheck, Clock, FileSpreadsheet, FlaskConical, Inbox, Layers, Menu, ScrollText, X } from "lucide-react";
import { IdentityPicker } from "./identity";
import { cx, type Icon } from "./kit";
import { VIEWS, type ViewId } from "./queue";
import { useRuns } from "./runs-context";
import { SystemStrip } from "./system-strip";

// The app frame: a dark ledger spine with the saved views and their live counts, the setup in brief and who is
// acting; on narrow screens it folds into a drawer behind a menu button.

const VIEW_ICON: Record<ViewId, Icon> = {
  review: Inbox,
  cleared: CircleCheck,
  waiting: Clock,
  approved: BadgeCheck,
  exported: FileSpreadsheet,
  closed: Archive,
  all: Layers,
};

const GROUPS: { label: string; views: ViewId[] }[] = [
  { label: "Work", views: ["review", "cleared", "waiting"] },
  { label: "Payment list", views: ["approved", "exported"] },
  { label: "Records", views: ["closed", "all"] },
];

function Mark({ className }: { className?: string }) {
  // The mark: a routing slip, three steps ticked off.
  return (
    <svg aria-hidden viewBox="0 0 28 32" className={className}>
      <path d="M3 1.5h22a1.5 1.5 0 0 1 1.5 1.5v26a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 29V3A1.5 1.5 0 0 1 3 1.5z" fill="#3b5bd6" />
      <circle cx="14" cy="5.5" r="1.6" fill="var(--spine)" />
      <path d="M6.5 12l2 2 3.5-4M6.5 19l2 2 3.5-4M6.5 26l2 2 3.5-4" fill="none" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15 12h6M15 19h6M15 26h4" stroke="#c7d2f7" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function Wordmark() {
  return (
    <Link href="/" className="group flex items-center gap-2.5 rounded-md">
      <Mark className="h-7 w-6 shrink-0" />
      <span className="min-w-0">
        <span className="block text-[15px] font-semibold leading-tight text-white">Supplier invoices</span>
        <span className="block truncate text-[12px] text-spine-ink-2">SpiceRoute Kitchens, AP</span>
      </span>
    </Link>
  );
}

function NavLink({
  href,
  icon: I,
  label,
  count,
  active,
  attention,
  onNavigate,
}: {
  href: string;
  icon: Icon;
  label: string;
  count?: number;
  active: boolean;
  attention?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cx(
        "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
        active ? "bg-spine-2 font-semibold text-white" : "text-spine-ink hover:bg-spine-2/60 hover:text-white",
      )}
    >
      <I aria-hidden size={16} className={active ? "text-white" : "text-spine-ink-2"} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count != null && (
        <span className={cx("num rounded px-1.5 text-[12px]", attention && count > 0 ? "bg-hold-edge font-semibold text-spine" : "text-spine-ink-2")}>
          {count}
          <span className="sr-only"> invoices</span>
        </span>
      )}
    </Link>
  );
}

function ViewLinks({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  const params = useSearchParams();
  const { data } = useRuns();
  const current = path === "/" ? (params.get("view") ?? "review") : null;
  const count = (id: ViewId) => (data ? data.runs.filter(VIEWS.find((v) => v.id === id)!.test).length : undefined);
  return (
    <>
      {GROUPS.map((g) => (
        <div key={g.label} className="mt-5 first:mt-0">
          <p className="px-2.5 pb-1 text-[11px] font-semibold tracking-[0.06em] text-spine-ink-2 uppercase">{g.label}</p>
          <ul className="space-y-0.5">
            {g.views.map((id) => {
              const v = VIEWS.find((x) => x.id === id)!;
              return (
                <li key={id}>
                  <NavLink
                    href={id === "review" ? "/" : `/?view=${id}`}
                    icon={VIEW_ICON[id]}
                    label={v.label}
                    count={count(id)}
                    active={current === id}
                    attention={id === "review" || id === "cleared"}
                    onNavigate={onNavigate}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}

function SetupLinks({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  return (
    <>
      <li>
        <NavLink href="/settings" icon={ScrollText} label="Rules and reference data" active={path === "/settings"} onNavigate={onNavigate} />
      </li>
      <li>
        <NavLink href="/demo" icon={FlaskConical} label="Demo inbox" active={path === "/demo"} onNavigate={onNavigate} />
      </li>
    </>
  );
}

function SideNavBody({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-4 pb-5">
        <Wordmark />
      </div>
      <nav aria-label="Invoices" className="min-h-0 flex-1 overflow-y-auto px-2">
        <Suspense fallback={null}>
          <ViewLinks onNavigate={onNavigate} />
        </Suspense>
        <div className="mt-5">
          <p className="px-2.5 pb-1 text-[11px] font-semibold tracking-[0.06em] text-spine-ink-2 uppercase">Setup</p>
          <ul className="space-y-0.5">
            <Suspense fallback={null}>
              <SetupLinks onNavigate={onNavigate} />
            </Suspense>
          </ul>
        </div>
      </nav>
      <div className="space-y-4 border-t border-spine-2 px-4 py-4">
        <IdentityPicker />
        <SystemStrip />
      </div>
    </div>
  );
}

/** The spine on wide screens; a top bar and a drawer below 1024 px. */
export function AppFrame({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const drawer = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = drawer.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15.5rem_minmax(0,1fr)]">
      <a href="#main" className="sr-only z-50 rounded-md bg-surface px-3 py-2 font-semibold text-carbon-deep focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
        Skip to content
      </a>
      <aside className="hidden bg-spine lg:block">
        <div className="sticky top-0 h-dvh">
          <SideNavBody />
        </div>
      </aside>
      <div className="flex min-w-0 flex-col">
        <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-spine-2 bg-spine px-3 py-2 lg:hidden">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-md p-2 text-spine-ink hover:bg-spine-2 hover:text-white"
            aria-label="Open menu"
            aria-haspopup="dialog"
          >
            <Menu aria-hidden size={20} />
          </button>
          <Wordmark />
        </div>
        <main id="main" className="mx-auto w-full max-w-[96rem] flex-1 px-4 py-5 sm:px-6 lg:px-8 lg:py-6">
          {children}
        </main>
      </div>
      <dialog
        ref={drawer}
        className="drawer lg:hidden"
        aria-label="Menu"
        onCancel={(e) => {
          e.preventDefault();
          setOpen(false);
        }}
        onClick={(e) => {
          if (e.target === drawer.current) setOpen(false);
        }}
      >
        {open && (
          <div className="relative h-full">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="absolute top-3 right-3 z-10 rounded-md p-1.5 text-spine-ink hover:bg-spine-2 hover:text-white"
              aria-label="Close menu"
            >
              <X aria-hidden size={18} />
            </button>
            <SideNavBody onNavigate={() => setOpen(false)} />
          </div>
        )}
      </dialog>
    </div>
  );
}

/** Breadcrumbs, the page title and its actions: the same header on every page. */
export function PageHeader({
  crumbs,
  title,
  meta,
  actions,
  children,
}: {
  crumbs?: { href?: string; label: string }[];
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="mb-5">
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-1.5">
          <ol className="flex flex-wrap items-center gap-1 text-[13px] text-ink-3">
            {crumbs.map((c, i) => (
              <li key={`${c.label}-${i}`} className="flex items-center gap-1">
                {i > 0 && <ChevronRight aria-hidden size={13} />}
                {c.href ? (
                  <Link href={c.href} className="hover:text-carbon-deep hover:underline">
                    {c.label}
                  </Link>
                ) : (
                  <span aria-current="page" className="text-ink-2">
                    {c.label}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="flex flex-col gap-x-6 gap-y-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] text-ink sm:text-2xl">{title}</h1>
          {meta && <div className="mt-1 max-w-[80ch] text-[13px] text-ink-2">{meta}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}
