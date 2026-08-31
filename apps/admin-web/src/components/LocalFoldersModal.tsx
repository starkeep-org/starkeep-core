"use client";

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
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  watches: Watch[] | null;
  path: string;
  onPathChange: (path: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
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
              <div key={w.id} className="flex items-center justify-between gap-2 rounded-md border p-2">
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
