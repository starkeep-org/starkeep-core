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
import type { AppList, ScanProblem } from "@/lib/app-types";

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

function AppDiscoveryModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [dirs, setDirs] = useState<string[] | null>(null);
  const [newDir, setNewDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // What the last added directory contributed, so an author who picked the
  // wrong folder hears so at once rather than seeing nothing change.
  const [report, setReport] = useState<{
    dir: string;
    appCount: number;
    problems: ScanProblem[];
  } | null>(null);

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
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const save = useCallback(async (next: string[]): Promise<boolean> => {
    setSaving(true);
    setError(null);
    setReport(null);
    try {
      const res = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appParentDirs: next }),
      });
      if (!res.ok) throw new Error(`config save failed: ${res.status}`);
      setDirs(next);
      window.dispatchEvent(new Event(APPS_CHANGED_EVENT));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const add = () => {
    const d = newDir.trim();
    if (!d || (dirs ?? []).includes(d)) {
      setNewDir("");
      return;
    }
    setNewDir("");
    void save([...(dirs ?? []), d]).then(async (saved) => {
      if (!saved) return;
      try {
        const res = await fetch("/api/apps/list");
        if (!res.ok) return;
        const body = (await res.json()) as AppList;
        setReport({
          dir: d,
          appCount: body.dirs.find((x) => x.dir === d)?.appCount ?? 0,
          problems: body.problems.filter((p) => p.configuredDir === d),
        });
      } catch {
        // The list itself reports on the Dashboard; the dialog stays quiet.
      }
    });
  };

  const remove = (d: string) => save((dirs ?? []).filter((x) => x !== d));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>App discovery</DialogTitle>
          <DialogDescription>
            Directories scanned for apps. A directory holding a{" "}
            <code className="text-xs">starkeep.manifest.json</code> is an app; any other directory
            is scanned for app subdirectories.
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
          <p className="text-sm text-muted-foreground">
            No directories — no apps will be discovered.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {dirs.map((d) => (
              <li key={d} className="flex items-center justify-between gap-2 rounded-md border p-2">
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
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
            disabled={saving}
          />
          <Button size="sm" onClick={add} disabled={saving || newDir.trim().length === 0}>
            Add directory
          </Button>
        </div>

        {report && (
          <div className="flex flex-col gap-1 text-sm">
            <p>
              {report.appCount === 0
                ? "No app found in "
                : `Found ${report.appCount} ${report.appCount === 1 ? "app" : "apps"} in `}
              <code className="text-xs">{report.dir}</code>.
            </p>
            {report.problems.length > 0 && (
              <ul className="flex flex-col gap-1 text-muted-foreground">
                {report.problems.map((p) => (
                  <li key={p.dir}>
                    <code className="text-xs break-all">{p.dir}</code>: {p.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
