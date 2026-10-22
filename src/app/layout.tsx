import type { Metadata } from "next";
import Link from "next/link";
import "@fontsource-variable/atkinson-hyperlegible-next";
import "./globals.css";
import { IdentityPicker, IdentityProvider } from "@/ui/identity";
import { SystemStrip } from "@/ui/system-strip";

export const metadata: Metadata = {
  title: "Supplier invoices | SpiceRoute Kitchens",
  description: "Invoice intake, checks against purchase orders, and approval for the payment list.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-IN" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <IdentityProvider>
          <header className="border-b border-rule bg-surface">
            <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-3 sm:px-6">
              <Link href="/" className="group flex items-center gap-3">
                {/* The mark: a routing slip, three steps ticked off. */}
                <svg aria-hidden viewBox="0 0 28 32" className="h-8 w-7 shrink-0">
                  <path d="M3 1.5h22a1.5 1.5 0 0 1 1.5 1.5v26a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 29V3A1.5 1.5 0 0 1 3 1.5z" fill="var(--carbon)" />
                  <circle cx="14" cy="5.5" r="1.6" fill="var(--surface)" />
                  <path d="M6.5 12l2 2 3.5-4M6.5 19l2 2 3.5-4M6.5 26l2 2 3.5-4" fill="none" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M15 12h6M15 19h6M15 26h4" stroke="var(--carbon-wash)" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
                <span>
                  <span className="block text-[1.1875rem] font-[780] leading-tight tracking-[-0.01em] text-ink group-hover:text-carbon-deep">Supplier invoices</span>
                  <span className="block text-sm text-ink-2">SpiceRoute Kitchens Pvt Ltd, accounts payable</span>
                </span>
              </Link>
              <div className="flex items-start gap-6">
                <nav aria-label="Main" className="flex gap-4 pt-1 text-sm whitespace-nowrap">
                  <Link href="/" className="text-ink-2 hover:text-ink">
                    Invoices
                  </Link>
                  <Link href="/settings" className="text-ink-2 hover:text-ink">
                    Rules
                  </Link>
                  <Link href="/demo" className="text-ink-2 hover:text-ink">
                    Demo emails
                  </Link>
                </nav>
                <IdentityPicker />
              </div>
            </div>
            <div className="mx-auto max-w-7xl px-4 pb-2 sm:px-6">
              <SystemStrip />
            </div>
          </header>
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">{children}</main>
        </IdentityProvider>
      </body>
    </html>
  );
}
