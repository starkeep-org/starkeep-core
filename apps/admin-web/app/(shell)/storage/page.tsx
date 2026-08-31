"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RetentionMatrix } from "../../../src/components/RetentionMatrix";
import { CommandOutputModal } from "../../../src/components/CommandOutputModal";

export default function StoragePage() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);

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

      {/* The one destructive action in the console, kept away from the routine
          controls on the dashboard. */}
      <div className="mt-8 flex items-center justify-between gap-4 rounded-lg border border-destructive/30 p-4">
        <div>
          <h2 className="font-medium">Clear local data</h2>
          <p className="text-sm text-muted-foreground">
            Deletes every local object file, the SQLite database, and the watch configs on
            this machine. Cloud data is untouched.
          </p>
        </div>
        <Button
          variant="outline"
          className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => setConfirmOpen(true)}
        >
          Clear local data
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Clear local data</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will permanently delete all local object files, the SQLite database, and
            watch configs.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => { setConfirmOpen(false); setOutputOpen(true); }}
            >
              Confirm
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <CommandOutputModal
        opened={outputOpen}
        onClose={() => setOutputOpen(false)}
        commandId={outputOpen ? "reset-local-data" : null}
        title="Clear local data"
      />
    </div>
  );
}
