"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// ---------------------------------------------------------------------------
// App parent directories editor — the "Discover apps" button that expands into
// a panel for managing the parent directories scanned for apps.
// ---------------------------------------------------------------------------

export function AppDiscovery({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
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

  useEffect(() => { load(); }, [load]);

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
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [onSaved]);

  const add = () => {
    const d = newDir.trim();
    if (!d || (dirs ?? []).includes(d)) { setNewDir(""); return; }
    setNewDir("");
    save([...(dirs ?? []), d]);
  };

  const remove = (d: string) => save((dirs ?? []).filter((x) => x !== d));

  if (!open) {
    return (
      <Button variant="outline" size="sm" className="w-fit" onClick={() => setOpen(true)}>
        Discover apps
      </Button>
    );
  }

  return (
    <div className="rounded-lg border p-5 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">App discovery</h2>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Hide</Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Parent directories scanned for apps (each subdir with a{" "}
        <code className="text-xs">starkeep.manifest.json</code>).
        Parent app directories should be added as siblings to starkeep-core.
      </p>

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
        <ul className="flex flex-col gap-1">
          {dirs.map((d) => (
            <li key={d} className="flex items-center justify-between gap-2 text-sm">
              <code className="text-xs break-all">{d}</code>
              <Button variant="outline" size="sm" onClick={() => remove(d)} disabled={saving}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        <Input
          placeholder="/path/to/app-parent-dir  (or ~/...)"
          value={newDir}
          onChange={(e) => setNewDir(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          disabled={saving}
        />
        <Button onClick={add} disabled={saving || newDir.trim().length === 0}>Add</Button>
      </div>
    </div>
  );
}
