import { useCallback, useEffect, useState } from "react";
import { TriangleAlertIcon } from "lucide-react";
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
import type { AppList, ScannedDir } from "@/lib/app-types";

// ---------------------------------------------------------------------------
// App parent directories editor — the "Discover apps" button in the shell
// header, which opens a modal for managing the directories scanned for apps.
// Under each directory the modal says which apps it contributed and why any
// folder in it was skipped, and the button carries an alert icon while any
// directory has a problem.
//
// The button lives in the shell header, away from the dashboard state it
// affects, so saving announces itself on `window` instead of calling back
// through props. The dashboard listens and re-scans, and so does the button.
// ---------------------------------------------------------------------------

/** Fired after the scanned-directory list changes. */
export const APPS_CHANGED_EVENT = "starkeep:app-dirs-changed";

/**
 * What each scanned directory contributed, or null before the first scan
 * answers. Rescans on mount, on every APPS_CHANGED_EVENT, and whenever
 * `rescanKey` changes.
 */
function useScannedDirs(rescanKey: unknown): ScannedDir[] | null {
  const [dirs, setDirs] = useState<ScannedDir[] | null>(null);
  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try {
        const res = await fetch("/api/apps/list");
        if (!res.ok) return;
        const body = (await res.json()) as AppList;
        if (live) setDirs(body.dirs);
      } catch {
        // The Dashboard reports a failed list; the header stays quiet.
      }
    };
    void refresh();
    window.addEventListener(APPS_CHANGED_EVENT, refresh);
    return () => {
      live = false;
      window.removeEventListener(APPS_CHANGED_EVENT, refresh);
    };
  }, [rescanKey]);
  return dirs;
}

export function AppDiscovery() {
  const [open, setOpen] = useState(false);
  // Opening the modal rescans, so a folder fixed on disk shows as fixed.
  const scanned = useScannedDirs(open);
  const hasProblems = (scanned ?? []).some((d) => d.problems.length > 0);

  return (
    <>
      <div className="flex items-center gap-2">
        {hasProblems && (
          <TriangleAlertIcon
            role="img"
            aria-label="App discovery found problems"
            className="size-4 text-amber-600"
          />
        )}
        <Button size="sm" className={ACTION_START} onClick={() => setOpen(true)}>
          Discover apps
        </Button>
      </div>
      <AppDiscoveryModal open={open} onOpenChange={setOpen} scanned={scanned} />
    </>
  );
}

/**
 * The apps line under a scanned directory: "Found Photos", "Found Photos and
 * Drive", "Found Photos, Drive, and 2 more apps". Null when the directory
 * holds no app, where the line is "No apps found" or the problems alone.
 */
export function foundAppsLine(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `Found ${names[0]}`;
  if (names.length === 2) return `Found ${names[0]} and ${names[1]}`;
  const more = names.length - 2;
  return `Found ${names[0]}, ${names[1]}, and ${more} more ${more === 1 ? "app" : "apps"}`;
}

function DirStatus({ status }: { status: ScannedDir | undefined }) {
  if (!status) return null;
  const found = foundAppsLine(status.apps.map((a) => a.name));
  return (
    <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      {found ? <p>{found}</p> : status.problems.length === 0 && <p>No apps found</p>}
      {status.problems.map((p) => (
        <p key={p.dir + p.reason} className="text-amber-700 dark:text-amber-400">
          {p.reason}
        </p>
      ))}
    </div>
  );
}

function AppDiscoveryModal({
  open,
  onOpenChange,
  scanned,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scanned: ScannedDir[] | null;
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
  useEffect(() => {
    if (open) load();
  }, [open, load]);

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
    if (!d || (dirs ?? []).includes(d)) {
      setNewDir("");
      return;
    }
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
            A directory that holds a <code className="text-xs">starkeep.manifest.json</code> is one
            app, and in any other directory each subdirectory with a manifest is an app.
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
              <li key={d} className="flex items-start justify-between gap-2 rounded-md border p-2">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <code className="truncate text-xs">{d}</code>
                  <DirStatus status={scanned?.find((x) => x.dir === d)} />
                </div>
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
            placeholder="~/starkeep-apps"
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
      </DialogContent>
    </Dialog>
  );
}
