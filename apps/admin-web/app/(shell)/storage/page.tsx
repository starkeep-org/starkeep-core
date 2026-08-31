"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { RetentionMatrix } from "../../../src/components/RetentionMatrix";

export default function StoragePage() {
  return (
    <div className="p-6 max-w-5xl">
      <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
        ← Dashboard
      </Link>
      <div className="mt-2 mb-2 flex items-center gap-2">
        <h1 className="text-2xl font-semibold">Storage</h1>
        <Badge variant="outline" className="text-xs">Experimental</Badge>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        What this machine keeps, and what it would cost. Projected from a count of the
        library rather than an estimate, so the numbers move when the library does.
      </p>
      <div className="rounded-lg border p-6">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-5">
          Retention &amp; budgets
        </h2>
        <RetentionMatrix />
      </div>
    </div>
  );
}
