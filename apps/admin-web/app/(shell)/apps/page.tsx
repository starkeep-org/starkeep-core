"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { CommandOutput } from "@/components/CommandOutput";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  readCloudConfig,
  readCognitoSession,
  writeCloudCredentials,
  writeCognitoSession,
} from "@/lib/cloud-config";
import { refreshTokens, getIdentityPoolCredentials, type STSCredentials } from "@/lib/cognito-auth";

export default function AppsPage() {
  return (
    <div className="max-w-3xl flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Apps</h1>
      <LocalAppsSection />
      <CloudPhotosSection />
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
    canIngestUnknown?: boolean;
    canPromoteFromUnknown?: boolean;
  };
}

interface LocalAppEntry {
  appId: string;
  manifest: ManifestSummary;
  sourceDir: string;
  status: "active" | "installing" | "uninstalling" | "not_installed";
}

interface DaemonStatus { running: boolean; pid?: number; port?: number; }

function LocalAppsSection() {
  const [apps, setApps] = useState<LocalAppEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingConsent, setPendingConsent] = useState<LocalAppEntry | null>(null);
  const [busyAppId, setBusyAppId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<Record<string, DaemonStatus>>({});
  // Per-app pending transition. We keep this set until the polled status
  // reflects the target state (running for "start", not-running for "stop"),
  // so the spinner survives the first poll round.
  const [pending, setPending] = useState<Record<string, "start" | "stop" | undefined>>({});

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

  const refreshStatus = useCallback(async (appIds: string[]) => {
    const entries = await Promise.all(appIds.map(async (id) => {
      try {
        const res = await fetch(`/api/exec/daemon/status?id=${encodeURIComponent(id)}`);
        if (!res.ok) return [id, { running: false }] as const;
        return [id, (await res.json()) as DaemonStatus] as const;
      } catch {
        return [id, { running: false }] as const;
      }
    }));
    setRunStatus((prev) => {
      const next = { ...prev };
      for (const [id, s] of entries) next[id] = s;
      return next;
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // One-shot status fetch for all installed apps when the list changes. No
  // background polling — we only poll while a specific transition is in
  // flight (see waitForTransition below).
  const installedIds = apps?.filter((a) => a.status === "active").map((a) => a.appId) ?? [];
  const installedKey = installedIds.join(",");
  useEffect(() => {
    if (installedIds.length === 0) return;
    refreshStatus(installedIds);
  }, [installedKey, refreshStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll one app's status until it matches the requested transition, with a
  // hard cap. Resolves with the final status, or null on timeout.
  const waitForTransition = useCallback(
    async (appId: string, want: "start" | "stop"): Promise<DaemonStatus | null> => {
      const MAX_ATTEMPTS = 20; // 20 × 1s = 20s
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        let s: DaemonStatus = { running: false };
        try {
          const res = await fetch(`/api/exec/daemon/status?id=${encodeURIComponent(appId)}`);
          if (res.ok) s = (await res.json()) as DaemonStatus;
        } catch { /* keep s as not-running and retry */ }
        setRunStatus((prev) => ({ ...prev, [appId]: s }));
        if ((want === "start" && s.running) || (want === "stop" && !s.running)) return s;
      }
      return null;
    },
    [],
  );

  const handleStart = async (appId: string) => {
    setPending((p) => ({ ...p, [appId]: "start" }));
    try {
      const res = await fetch("/api/exec/daemon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", id: appId }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `start failed: ${res.status}`);
      }
      const final = await waitForTransition(appId, "start");
      if (!final) setError(`${appId} did not come online within 20s`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending((p) => { const n = { ...p }; delete n[appId]; return n; });
    }
  };

  const handleStop = async (appId: string) => {
    setPending((p) => ({ ...p, [appId]: "stop" }));
    try {
      const res = await fetch("/api/exec/daemon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", id: appId }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `stop failed: ${res.status}`);
      }
      const final = await waitForTransition(appId, "stop");
      if (!final) setError(`${appId} did not shut down within 20s`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending((p) => { const n = { ...p }; delete n[appId]; return n; });
    }
  };

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
        const status = runStatus[entry.appId];
        const want = pending[entry.appId];
        const running = status?.running === true;
        const port = status?.port;
        const busy = !!want;
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
                {installed && running && port && (
                  <a
                    href={`http://localhost:${port}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Open http://localhost:${port}`}
                  >
                    <Badge variant="secondary" className="text-xs bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 hover:bg-blue-200 dark:hover:bg-blue-800 cursor-pointer">
                      Running :{port} ↗
                    </Badge>
                  </a>
                )}
                {installed && !running && want === "start" && (
                  <Badge variant="secondary" className="text-xs bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                    Starting…
                  </Badge>
                )}
                {installed && running && want === "stop" && (
                  <Badge variant="secondary" className="text-xs bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                    Stopping…
                  </Badge>
                )}
              </div>
              <div className="flex gap-2 items-center">
                {installed && running && port && (
                  <a
                    href={`http://localhost:${port}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm underline"
                  >
                    Open ↗
                  </a>
                )}
                {installed && !running && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleStart(entry.appId)}
                    disabled={busy}
                  >
                    {want === "start" && (
                      <span className="mr-1 size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    )}
                    {want === "start" ? "Starting…" : "Start"}
                  </Button>
                )}
                {installed && running && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleStop(entry.appId)}
                    disabled={busy}
                  >
                    {want === "stop" && (
                      <span className="mr-1 size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    )}
                    {want === "stop" ? "Stopping…" : "Stop"}
                  </Button>
                )}
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
                    disabled={busyAppId === entry.appId || running || busy}
                    title={running ? "Stop the app before uninstalling" : undefined}
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

// ---------------------------------------------------------------------------
// Cloud photos section
// ---------------------------------------------------------------------------

function CloudPhotosSection() {
  const [installOpen, setInstallOpen] = useState(false);
  const [credentials, setCredentials] = useState<STSCredentials | null>(null);
  const [credError, setCredError] = useState<string | null>(null);
  const [installed, setInstalled] = useState(false);

  const handleInstall = async () => {
    setCredError(null);
    const cfg = await readCloudConfig();
    if (!cfg) { setCredError("Cloud is not configured. Complete the cloud setup first."); return; }

    const session = await readCognitoSession();
    if (!session?.refreshToken) { setCredError("Not signed in. Sign in from the dashboard first."); return; }

    let creds: STSCredentials;
    try {
      const tokens = await refreshTokens(cfg.cognitoConfig, session.refreshToken);
      creds = await getIdentityPoolCredentials(cfg.cognitoConfig, tokens.idToken);
      await writeCloudCredentials(creds);
      await writeCognitoSession({ ...session, refreshToken: tokens.refreshToken });
    } catch (err) {
      setCredError(err instanceof Error ? err.message : "Failed to get AWS credentials");
      return;
    }

    setCredentials({ ...creds, region: cfg.region } as STSCredentials & { region: string });
    setInstallOpen(true);
  };

  return (
    <div className="rounded-lg border p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Photos — cloud install</h2>
        {installed && (
          <Badge variant="secondary" className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
            Installed
          </Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Deploy the photos app to AWS. Requires cloud infrastructure to be set up and a valid
        sign-in session.
      </p>

      {credError && (
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{credError}</AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end">
        <Button size="sm" onClick={handleInstall}>
          {installed ? "Redeploy" : "Install in cloud"}
        </Button>
      </div>

      <CloudPhotosInstallModal
        opened={installOpen}
        credentials={credentials}
        onClose={() => { setInstallOpen(false); setCredentials(null); }}
        onSuccess={() => setInstalled(true)}
      />
    </div>
  );
}

function CloudPhotosInstallModal({
  opened,
  credentials,
  onClose,
  onSuccess,
}: {
  opened: boolean;
  credentials: STSCredentials | null;
  onClose: () => void;
  onSuccess?: () => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "running" | "success" | "failure">("idle");

  useEffect(() => {
    if (!opened || !credentials) return;

    setLines([]);
    setStatus("running");
    let aborted = false;

    async function run() {
      try {
        const resp = await fetch("/api/apps/photos/cloud-install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accessKeyId: credentials!.accessKeyId,
            secretAccessKey: credentials!.secretAccessKey,
            sessionToken: credentials!.sessionToken,
            region: (credentials as STSCredentials & { region?: string }).region ?? "",
          }),
        });

        if (!resp.ok || !resp.body) {
          let errMsg = `${resp.status} ${resp.statusText}`;
          try {
            const j = (await resp.json()) as { error?: string };
            if (j.error) errMsg = j.error;
          } catch { /* not JSON */ }
          setLines((l) => [...l, `Error: ${errMsg}`]);
          setStatus("failure");
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done || aborted) break;

          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() ?? "";

          for (const chunk of chunks) {
            let eventType = "message";
            let data = "";
            for (const part of chunk.split("\n")) {
              if (part.startsWith("event: ")) eventType = part.slice(7);
              else if (part.startsWith("data: ")) data = part.slice(6);
            }
            if (eventType === "done") {
              setStatus("success");
              onSuccess?.();
            } else if (eventType === "error") {
              try { setLines((l) => [...l, `Error: ${(JSON.parse(data) as { message?: string }).message ?? data}`]); }
              catch { setLines((l) => [...l, `Error: ${data}`]); }
              setStatus("failure");
            } else if (data) {
              try { setLines((l) => [...l, JSON.parse(data) as string]); }
              catch { setLines((l) => [...l, data]); }
            }
          }
        }
      } catch (err) {
        if (!aborted) {
          setLines((l) => [...l, `Error: ${err instanceof Error ? err.message : String(err)}`]);
          setStatus("failure");
        }
      }
    }

    run();
    return () => { aborted = true; };
  }, [opened, credentials]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dialog open={opened} onOpenChange={(open) => { if (!open && status !== "running") onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Install photos app in cloud</DialogTitle>
        </DialogHeader>
        <CommandOutput lines={lines} status={status} />
        {status !== "running" && (
          <div className="flex justify-end">
            <Button variant="outline" onClick={onClose}>Close</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
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
  const canIngestUnknown = entry.manifest.infraRequirements?.canIngestUnknown;
  const canPromoteFromUnknown = entry.manifest.infraRequirements?.canPromoteFromUnknown;

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

