import type { Metadata } from "next";
import "@fontsource-variable/ibm-plex-sans";
import "./globals.css";
import { IdentityProvider } from "@/ui/identity";
import { RunsProvider } from "@/ui/runs-context";
import { AppFrame } from "@/ui/shell";

export const metadata: Metadata = {
  title: "Supplier invoices | SpiceRoute Kitchens",
  description: "Invoice intake, checks against purchase orders, and approval for the payment list.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-IN" className="h-full antialiased">
      <body className="min-h-full">
        <IdentityProvider>
          <RunsProvider>
            <AppFrame>{children}</AppFrame>
          </RunsProvider>
        </IdentityProvider>
      </body>
    </html>
  );
}
