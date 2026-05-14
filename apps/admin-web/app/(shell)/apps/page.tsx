"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

export default function AppsPage() {
  return (
    <div className="max-w-3xl flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Apps</h1>
      <LocalAppsSection />
    </div>
  );
}

interface SharedTypeAccess {
  typeId: string;
  access: "read" | "readwrite";
  metadataWrite?: boolean;
  rationale: string;
}

interface ManifestSummary {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  infraRequirements?: {
    sharedTypeAccess?: SharedTypeAccess[];
    appPrivate?: {
      canIngestUnknown?: boolean;
      canPromoteFromUnknown?: boolean;
    };
  };
}

interface LocalAppEntry {
  appId: string;
  manifest: ManifestSummary;
  sourceDir: string;
  status: "active" | "installing" | "uninstalling" | "not_installed";
}

function LocalAppsSection() {
  const [apps, setApps] = useState<LocalAppEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingConsent, setPendingConsent] = useState<LocalAppEntry | null>(null);
  const [busyAppId, setBusyAppId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/apps/list");
      if (!res.ok) throw new Error(`list failed: ${res.status}`);
      const body = (await res.json()) as { apps: LocalAppEntry[] };
      setApps(body.apps);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleApprove = async (entry: LocalAppEntry) => {
    setPendingConsent(null);
    setBusyAppId(entry.appId);
    setError(null);
    try {
      const res = await fetch("/api/apps/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: entry.appId, approved: true }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `install failed: ${res.status}`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAppId(null);
    }
  };

  const handleUninstall = async (entry: LocalAppEntry) => {
    if (!confirm(`Uninstall ${entry.appId}? Records it produced will remain in shared storage.`)) return;
    setBusyAppId(entry.appId);
    setError(null);
    try {
      const res = await fetch("/api/apps/uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: entry.appId }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `uninstall failed: ${res.status}`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAppId(null);
    }
  };

  return (
    <div className="rounded-lg border p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Local install</h2>
        <Button variant="outline" size="sm" onClick={refresh}>Refresh</Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Apps discovered from <code className="text-xs">starkeep-apps/</code>. Installing wires the
        app into the local data server with its declared per-type permissions.
      </p>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {apps === null && <p className="text-sm text-muted-foreground">Loading…</p>}
      {apps !== null && apps.length === 0 && (
        <p className="text-sm text-muted-foreground">No apps found in starkeep-apps/.</p>
      )}

      {apps?.map((entry) => {
        const grants = entry.manifest.infraRequirements?.sharedTypeAccess ?? [];
        const installed = entry.status === "active";
        return (
          <div key={entry.appId} className="rounded-md border p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="font-medium">{entry.manifest.name ?? entry.appId}</span>
                <span className="text-xs text-muted-foreground">v{entry.manifest.version ?? "?"}</span>
                {installed && (
                  <Badge variant="secondary" className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                    Installed
                  </Badge>
                )}
              </div>
              <div className="flex gap-2">
                {!installed && (
                  <Button
                    size="sm"
                    onClick={() => setPendingConsent(entry)}
                    disabled={busyAppId === entry.appId}
                  >
                    {busyAppId === entry.appId ? "Installing…" : "Install"}
                  </Button>
                )}
                {installed && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleUninstall(entry)}
                    disabled={busyAppId === entry.appId}
                  >
                    {busyAppId === entry.appId ? "Uninstalling…" : "Uninstall"}
                  </Button>
                )}
              </div>
            </div>
            {entry.manifest.description && (
              <p className="text-sm text-muted-foreground">{entry.manifest.description}</p>
            )}
            {grants.length > 0 && (
              <ul className="text-xs text-muted-foreground flex flex-col gap-0.5">
                {grants.map((g) => (
                  <li key={g.typeId}>
                    <span className="font-mono">{g.typeId}</span>: {g.access}
                    {g.metadataWrite ? " + metadata:write" : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      {pendingConsent && (
        <ConsentModal
          entry={pendingConsent}
          onApprove={() => handleApprove(pendingConsent)}
          onCancel={() => setPendingConsent(null)}
        />
      )}
    </div>
  );
}

function ConsentModal({
  entry,
  onApprove,
  onCancel,
}: {
  entry: LocalAppEntry;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const grants = entry.manifest.infraRequirements?.sharedTypeAccess ?? [];
  const canIngestUnknown = entry.manifest.infraRequirements?.appPrivate?.canIngestUnknown;
  const canPromoteFromUnknown = entry.manifest.infraRequirements?.appPrivate?.canPromoteFromUnknown;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-background rounded-lg border shadow-lg max-w-lg w-full flex flex-col gap-4 p-5">
        <h3 className="text-lg font-semibold">
          Install {entry.manifest.name ?? entry.appId}?
        </h3>
        <p className="text-sm text-muted-foreground">
          This app is requesting the following access to your shared data. Other apps with grants on
          the same types will see records this app creates; records persist if the app is uninstalled.
        </p>

        {grants.length === 0 ? (
          <p className="text-sm">No shared-type grants requested.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {grants.map((g) => {
              // Per design: any access (read or readwrite) implicitly grants
              // SELECT on the per-type metadata table. metadataWrite adds
              // INSERT/UPDATE on top of that read.
              const dataPermissions = g.access === "readwrite" ? "read + write" : "read";
              const metadataPermissions = g.metadataWrite ? "read + write" : "read";
              return (
                <li key={g.typeId} className="border rounded-md p-3 flex flex-col gap-1">
                  <div className="flex items-center gap-2 text-sm flex-wrap">
                    <span className="font-mono">{g.typeId}</span>
                    <Badge variant="secondary" className="text-xs">records: {dataPermissions}</Badge>
                    <Badge variant="secondary" className="text-xs">metadata: {metadataPermissions}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{g.rationale}</p>
                </li>
              );
            })}
          </ul>
        )}

        {(canIngestUnknown || canPromoteFromUnknown) && (
          <div className="text-xs text-muted-foreground">
            Additionally: {canIngestUnknown ? "ingest unknown-type files; " : ""}
            {canPromoteFromUnknown ? "promote unknown records to typed records" : ""}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={onApprove}>Approve &amp; Install</Button>
        </div>
      </div>
    </div>
  );
}

