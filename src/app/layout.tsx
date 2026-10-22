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
              <div>
                <Link href="/" className="text-lg font-bold tracking-tight text-ink hover:text-carbon-deep">
                  Supplier invoices
                </Link>
                <p className="text-sm text-ink-2">SpiceRoute Kitchens Pvt Ltd, accounts payable</p>
              </div>
              <div className="flex items-start gap-6">
                <nav aria-label="Main" className="flex gap-4 pt-1 text-sm">
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
