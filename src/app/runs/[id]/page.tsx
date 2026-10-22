import { Suspense } from "react";
import { RunView } from "@/ui/run-view";

export default function RunPage() {
  return (
    <Suspense fallback={<p className="py-16 text-center text-ink-2">Loading the invoice</p>}>
      <RunView />
    </Suspense>
  );
}
