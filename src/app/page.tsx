import { Suspense } from "react";
import { Desk } from "@/ui/desk";

export default function Home() {
  return (
    <Suspense fallback={<p className="py-16 text-center text-ink-2">Loading the desk</p>}>
      <Desk />
    </Suspense>
  );
}
