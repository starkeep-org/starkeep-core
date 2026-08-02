"use client";

import { RetentionMatrix } from "../../../src/components/RetentionMatrix";

export default function StoragePage() {
  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-semibold mb-2">Storage</h1>
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
