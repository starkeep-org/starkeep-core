"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ACTION_START } from "@/lib/action-colors";

// ---------------------------------------------------------------------------
// App parent directories editor — the "Discover apps" button in the shell
// header, which opens a modal for managing the directories scanned for apps.
//
// The button lives in the shell header, away from the dashboard state it
// affects, so saving announces itself on `window` instead of calling back
// through props. The dashboard listens and re-scans.
// ---------------------------------------------------------------------------

/** Fired after the scanned-directory list changes. */
export const APPS_CHANGED_EVENT = "starkeep:app-dirs-changed";

export function AppDiscovery() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button size="sm" className={ACTION_START} onClick={() => setOpen(true)}>
        Discover apps
      </Button>
      <AppDiscoveryModal open={open} onOpenChange={setOpen} />
    </>
  );
}

function AppDiscoveryModal({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [dirs, setDirs] = useState<string[] | null>(null);
  const [newDir, setNewDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/config");
      if (!res.ok) throw new Error(`config load failed: ${res.status}`);
      const body = (await res.json()) as { config: { appParentDirs?: string[] } | null };
      setDirs(body.config?.appParentDirs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Reload on every open, so a directory added in another tab shows up.
  useEffect(() => { if (open) load(); }, [open, load]);

  const save = useCallback(async (next: string[]) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appParentDirs: next }),
      });
      if (!res.ok) throw new Error(`config save failed: ${res.status}`);
      setDirs(next);
      window.dispatchEvent(new Event(APPS_CHANGED_EVENT));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, []);

  const add = () => {
    const d = newDir.trim();
    if (!d || (dirs ?? []).includes(d)) { setNewDir(""); return; }
    setNewDir("");
    save([...(dirs ?? []), d]);
  };

  const remove = (d: string) => save((dirs ?? []).filter((x) => x !== d));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>App discovery</DialogTitle>
          <DialogDescription>
            Parent directories scanned for apps — each subdirectory holding a{" "}
            <code className="text-xs">starkeep.manifest.json</code> counts as an app.
            Add parent directories as siblings to starkeep-core.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {dirs === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : dirs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No directories — no apps will be discovered.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {dirs.map((d) => (
              <li
                key={d}
                className="flex items-center justify-between gap-2 rounded-md border p-2"
              >
                <code className="min-w-0 flex-1 truncate text-xs">{d}</code>
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0 text-destructive hover:text-destructive"
                  onClick={() => remove(d)}
                  disabled={saving}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex gap-2">
          <Input
            placeholder="/path/to/app-parent-dir  (or ~/...)"
            className="h-8 text-sm"
            value={newDir}
            onChange={(e) => setNewDir(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            disabled={saving}
          />
          <Button size="sm" onClick={add} disabled={saving || newDir.trim().length === 0}>
            Add directory
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
