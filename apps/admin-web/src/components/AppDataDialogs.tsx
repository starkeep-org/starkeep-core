/**
 * The dialogs around an app's own data on this machine.
 *
 * Uninstall keeps an app's tables and files, so its dialog destroys nothing and
 * needs no typed confirmation. Deleting the data is a separate action on the
 * card of an app that is not installed. Its dialog shows what the deletion
 * destroys and whether the cloud holds a copy, and it asks for the app id.
 */
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { AppDataPreview } from "@/lib/app-types";

/** Fetches the counts of one app's data on this machine. */
function useAppDataPreview(appId: string | null) {
  const [preview, setPreview] = useState<AppDataPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPreview(null);
    setError(null);
    if (!appId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/apps/${encodeURIComponent(appId)}/data`);
        const body = (await res.json().catch(() => null)) as
          | (AppDataPreview & { message?: string; error?: string })
          | null;
        if (cancelled) return;
        if (!res.ok || !body) {
          setError(body?.message ?? body?.error ?? `data lookup failed: ${res.status}`);
          return;
        }
        setPreview(body);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appId]);
  return { preview, error };
}

export function UninstallDialog({
  appId,
  name,
  busy,
  onConfirm,
  onCancel,
}: {
  appId: string | null;
  name: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={appId !== null} onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Uninstall {name}?</DialogTitle>
          <DialogDescription>
            Uninstall stops {name} and removes its access to your data.
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc pl-5 text-sm flex flex-col gap-1">
          <li>{name}&rsquo;s own data stays on this machine, and reinstalling brings it back.</li>
          <li>Records {name} shared with other apps stay.</li>
          <li>To delete {name}&rsquo;s data, choose Delete data on its card after uninstalling.</li>
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={busy}>
            {busy ? "Uninstalling…" : "Uninstall"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteDataDialog({
  appId,
  name,
  onDeleted,
  onCancel,
}: {
  appId: string | null;
  name: string;
  onDeleted: () => void;
  onCancel: () => void;
}) {
  const { preview, error: loadError } = useAppDataPreview(appId);
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTyped("");
    setError(null);
  }, [appId]);

  const confirmed = appId !== null && typed === appId;

  const submit = async () => {
    if (!appId || !confirmed) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(appId)}/delete-data`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: typed }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
          error?: string;
        } | null;
        throw new Error(body?.message ?? body?.error ?? `delete failed: ${res.status}`);
      }
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={appId !== null} onOpenChange={(open) => !open && !deleting && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {name}&rsquo;s data on this machine?</DialogTitle>
          <DialogDescription>
            The deletion removes {name}&rsquo;s own tables and files from this machine. Records{" "}
            {name} shared with other apps stay, and other devices keep their copies.
          </DialogDescription>
        </DialogHeader>

        {loadError && (
          <Alert variant="destructive">
            <AlertTitle>Could not read the data</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}
        {!preview && !loadError && <p className="text-sm text-muted-foreground">Counting…</p>}
        {preview && (
          <div className="flex flex-col gap-3 text-sm">
            <DataCounts preview={preview} />
            <CloudCopyNote preview={preview} name={name} />
          </div>
        )}

        <label className="flex flex-col gap-1 text-sm">
          <span>
            Type <code className="font-mono">{appId}</code> to confirm.
          </span>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={deleting}
          />
        </label>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>Delete failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => void submit()}
            disabled={!confirmed || deleting || !preview}
          >
            {deleting ? "Deleting…" : "Delete data"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The install consent dialog's note for an app whose data an earlier
 * uninstall kept. The install reattaches that data.
 */
export function KeptDataNotice({ appId, name }: { appId: string; name: string }) {
  const { preview } = useAppDataPreview(appId);
  return (
    <Alert>
      <AlertTitle>This install brings back {name}&rsquo;s kept data</AlertTitle>
      <AlertDescription>
        {preview
          ? `An earlier uninstall kept ${describeCounts(preview)} on this machine. ${name} gets them back.`
          : `An earlier uninstall kept ${name}'s data on this machine. ${name} gets it back.`}
      </AlertDescription>
    </Alert>
  );
}

function DataCounts({ preview }: { preview: AppDataPreview }) {
  const nonEmpty = preview.tables.filter((t) => t.rowCount > 0);
  return (
    <div className="flex flex-col gap-1">
      <p>This machine holds {describeCounts(preview)}.</p>
      {nonEmpty.length > 1 && (
        <ul className="list-disc pl-5 text-muted-foreground">
          {nonEmpty.map((t) => (
            <li key={t.name}>
              <code className="font-mono text-xs">{t.name}</code>: {plural(t.rowCount, "row")}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CloudCopyNote({ preview, name }: { preview: AppDataPreview; name: string }) {
  if (preview.cloudCopy === "none") {
    return (
      <Alert variant="destructive">
        <AlertTitle>The deletion is permanent</AlertTitle>
        <AlertDescription>
          This machine never synced {name}&rsquo;s data to the cloud, so no cloud copy can restore
          it.
        </AlertDescription>
      </Alert>
    );
  }
  if (preview.cloudCopy === "behind") {
    return (
      <Alert variant="destructive">
        <AlertTitle>The cloud copy is missing recent changes</AlertTitle>
        <AlertDescription>
          This machine holds changes that it had not synced to the cloud. The deletion loses them.
          Reinstalling {name} here downloads the older cloud copy while {name} is installed in the
          cloud.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <p className="text-muted-foreground">
      The cloud held all of this data at the last sync. Reinstalling {name} on this machine
      downloads it again while {name} is installed in the cloud.
    </p>
  );
}

function describeCounts(preview: AppDataPreview): string {
  const rows = plural(preview.totalRows, "row");
  if (!preview.files || preview.files.count === 0) return rows;
  return `${rows} and ${plural(preview.files.count, "file")} (${formatBytes(preview.files.totalBytes)})`;
}

function plural(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}

/** Binary units, matching the operator's OS. */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${Number.isInteger(value) || value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}
