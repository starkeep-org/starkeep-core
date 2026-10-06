import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// ---------------------------------------------------------------------------
// Watch management, lifted out of the Data Server card. The card reports the
// folder and file counts; adding and removing a folder happens here, so the
// dashboard no longer grows with the number of watched directories.
//
// All fetch handling stays with the dashboard, which already owns the watch
// list and its refresh — this component renders and delegates.
// ---------------------------------------------------------------------------

export interface Watch {
  id: string;
  directoryPath: string;
  state: string;
  totalFiles: number;
  syncedFiles: number;
  /**
   * The paths that break the folder's promise, and the one that does not.
   *
   * A watched folder promises that everything inside it is in the library, and
   * three states qualify that. Two of them were completely invisible: a file that
   * left the disk while no cloud copy was confirmed, which is the only way a person
   * can lose data here, and a file on disk the library ignores on purpose because
   * the record was deleted. The third, `evicted`, is benign — the bytes are in the
   * cloud and a read brings them back — and is shown so a count below the total is
   * explained rather than alarming.
   *
   * Optional, because a daemon on an older build answers without them.
   */
  possiblyLost?: string[];
  excluded?: string[];
  evicted?: string[];
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  watches: Watch[] | null;
  path: string;
  onPathChange: (path: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  /** Put an excluded path back in the library, at its original id. */
  onAddBack: (path: string) => void;
  /** The path an add-back is in flight for, so its control can say so. */
  addingBack: string | null;
  submitting: boolean;
  error: string | null;
  success: string | null;
}

export function LocalFoldersModal({
  open,
  onOpenChange,
  watches,
  path,
  onPathChange,
  onAdd,
  onRemove,
  onAddBack,
  addingBack,
  submitting,
  error,
  success,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Local folders</DialogTitle>
          <DialogDescription>
            Every file under a watched folder is indexed and kept in sync.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {watches && watches.length > 0 ? (
            watches.map((w) => (
              <div key={w.id} className="flex flex-col gap-2 rounded-md border p-2">
                <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="flex-1 truncate text-sm">{w.directoryPath}</span>
                  <Badge variant="outline" className="shrink-0 text-xs">{w.state}</Badge>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {w.syncedFiles}/{w.totalFiles}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0 text-destructive hover:text-destructive"
                  onClick={() => onRemove(w.id)}
                >
                  Remove
                </Button>
                </div>
                <WatchExceptions watch={w} onAddBack={onAddBack} addingBack={addingBack} />
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No folders are watched yet.</p>
          )}
        </div>

        <div className="flex gap-2">
          <Input
            placeholder="/path/to/directory or ~/Photos"
            className="h-8 text-sm"
            value={path}
            onChange={(e) => onPathChange(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onAdd(); }}
          />
          <Button size="sm" onClick={onAdd} disabled={submitting || !path.trim()}>
            {submitting && (
              <span className="mr-1 size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            )}
            Add folder
          </Button>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
        {success && <p className="text-xs text-green-600 dark:text-green-400">{success}</p>}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The paths a watched folder does not hold as it promises.
 *
 * Nothing is shown when there are none, which is the ordinary state. When there is
 * something, it is named by path rather than counted: a count tells the person
 * something is wrong and a path tells them which file, and only one of those can be
 * acted on.
 */
function WatchExceptions({
  watch,
  onAddBack,
  addingBack,
}: {
  watch: Watch;
  onAddBack: (path: string) => void;
  addingBack: string | null;
}) {
  const possiblyLost = watch.possiblyLost ?? [];
  const excluded = watch.excluded ?? [];
  const evicted = watch.evicted ?? [];
  if (possiblyLost.length === 0 && excluded.length === 0 && evicted.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 border-t pt-2 text-xs">
      {possiblyLost.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="font-medium text-destructive">
            {possiblyLost.length === 1 ? "1 file" : `${possiblyLost.length} files`} may be lost
          </span>
          <span className="text-muted-foreground">
            These left the folder before the cloud was confirmed to hold them, so Starkeep may
            have no copy. Put the file back, or delete the item from Drive&apos;s Trash.
          </span>
          {possiblyLost.map((p) => (
            <span key={p} className="truncate font-mono text-destructive" title={p}>
              {p}
            </span>
          ))}
        </div>
      )}

      {excluded.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="font-medium">
            {excluded.length === 1 ? "1 file" : `${excluded.length} files`} left out on purpose
          </span>
          <span className="text-muted-foreground">
            These are in the folder and you deleted them from the library, so Starkeep leaves them
            alone. Adding one back returns the original item, not a copy.
          </span>
          {excluded.map((p) => (
            <div key={p} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono" title={p}>
                {p}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                disabled={addingBack !== null}
                onClick={() => onAddBack(p)}
              >
                {addingBack === p ? "Adding…" : "Add back"}
              </Button>
            </div>
          ))}
        </div>
      )}

      {evicted.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">
            {evicted.length === 1 ? "1 file" : `${evicted.length} files`} left the folder and are
            kept in the cloud. They stay in the library and open on demand.
          </span>
        </div>
      )}
    </div>
  );
}
