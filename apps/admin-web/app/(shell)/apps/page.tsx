"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

type AppTarget = "local" | "cloud";

export default function AppsPage() {
  const [apps, setApps] = useState<LocalAppEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  // Membership comes from each app's manifest `targets` (default ["local"]).
  const targetsOf = (a: LocalAppEntry): AppTarget[] => a.manifest.targets ?? ["local"];
  const localApps = apps === null ? null : apps.filter((a) => targetsOf(a).includes("local"));
  const cloudApps = apps === null ? null : apps.filter((a) => targetsOf(a).includes("cloud"));

  return (
    <div className="max-w-3xl flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Apps</h1>

      <AppDirsEditor onSaved={refresh} />

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Local</h2>
        <DriveSection />
        <LocalAppsSection apps={localApps} refresh={refresh} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Cloud</h2>
        <CloudAppsSection apps={cloudApps} />
      </section>
    </div>
  );
}

interface FileAccess {
  extensions: string[];
  access: "read" | "readwrite";
  metadataWrite?: boolean;
  rationale: string;
}

interface ManifestSummary {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  targets?: AppTarget[];
  infraRequirements?: {
    fileAccess?: FileAccess[];
    fileAccessAll?: boolean;
  };
}

interface LocalAppEntry {
  appId: string;
  manifest: ManifestSummary;
  sourceDir: string;
  status: "active" | "installing" | "uninstalling" | "not_installed";
}

interface DaemonStatus { running: boolean; pid?: number; port?: number; }

// ---------------------------------------------------------------------------
// App parent directories editor
// ---------------------------------------------------------------------------

function AppDirsEditor({ onSaved }: { onSaved: () => void }) {
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

  return (
    <div className="rounded-lg border p-5 flex flex-col gap-3">
      <h2 className="text-base font-semibold">App discovery</h2>
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

// ---------------------------------------------------------------------------
// Starkeep Drive — built-in app installed with the core. Not manifest-discovered;
// it runs on a fixed port (9830) under the daemon id "drive".
// ---------------------------------------------------------------------------

const DRIVE_URL = "http://localhost:9830";

async function checkUrl(url: string): Promise<boolean> {
  try {
    await fetch(url, { mode: "no-cors", signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

function DriveSection() {
  const [online, setOnline] = useState<boolean | null>(null);
  const [pending, setPending] = useState<"start" | "stop" | null>(null);

  useEffect(() => {
    setOnline(null);
    checkUrl(DRIVE_URL).then(setOnline);
  }, []);

  // Poll the URL until it matches the requested transition, with a hard cap.
  const waitForTransition = useCallback(async (want: "start" | "stop") => {
    const MAX_ATTEMPTS = 20; // 20 × 1s = 20s
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const up = await checkUrl(DRIVE_URL);
      setOnline(up);
      if ((want === "start" && up) || (want === "stop" && !up)) return;
    }
  }, []);

  const transition = async (action: "start" | "stop") => {
    setPending(action);
    try {
      await fetch("/api/exec/daemon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, id: "drive" }),
      });
      await waitForTransition(action);
    } catch {
      /* leave status to the next check */
    } finally {
      setPending(null);
    }
  };

  const running = online === true;
  const busy = pending !== null;

  return (
    <div className="rounded-lg border p-5 flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Built-in apps installed with the core.
      </p>

      <div className="rounded-md border p-3 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="font-medium">Starkeep Drive</span>
            <Badge variant="secondary" className="text-xs">Built-in</Badge>
            {running && (
              <a href={DRIVE_URL} target="_blank" rel="noopener noreferrer" title={`Open ${DRIVE_URL}`}>
                <Badge variant="secondary" className="text-xs bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 hover:bg-blue-200 dark:hover:bg-blue-800 cursor-pointer">
                  Running ↗
                </Badge>
              </a>
            )}
          </div>
          <div className="flex gap-2 items-center">
            {running && (
              <a href={DRIVE_URL} target="_blank" rel="noopener noreferrer" className="text-sm underline">
                Open ↗
              </a>
            )}
            {online === false && (
              <Button size="sm" variant="outline" onClick={() => transition("start")} disabled={busy}>
                {pending === "start" && (
                  <span className="mr-1 size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                )}
                {pending === "start" ? "Starting…" : "Start"}
              </Button>
            )}
            {running && (
              <Button size="sm" variant="outline" onClick={() => transition("stop")} disabled={busy}>
                {pending === "stop" && (
                  <span className="mr-1 size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                )}
                {pending === "stop" ? "Stopping…" : "Stop"}
              </Button>
            )}
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          File browser and shared-data UI, installed with the core.
        </p>
      </div>
    </div>
  );
}

function LocalAppsSection({ apps, refresh }: { apps: LocalAppEntry[] | null; refresh: () => Promise<void>; }) {
  const [error, setError] = useState<string | null>(null);
  const [pendingConsent, setPendingConsent] = useState<LocalAppEntry | null>(null);
  const [busyAppId, setBusyAppId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<Record<string, DaemonStatus>>({});
  // Per-app pending transition. We keep this set until the polled status
  // reflects the target state (running for "start", not-running for "stop"),
  // so the spinner survives the first poll round.
  const [pending, setPending] = useState<Record<string, "start" | "stop" | undefined>>({});

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
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Installing wires the app into the local data server with its declared per-type
          permissions.
        </p>
        <Button variant="outline" size="sm" onClick={refresh}>Refresh</Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {apps === null && <p className="text-sm text-muted-foreground">Loading…</p>}
      {apps !== null && apps.length === 0 && (
        <p className="text-sm text-muted-foreground">No local apps found.</p>
      )}

      {apps?.map((entry) => {
        const grants = entry.manifest.infraRequirements?.fileAccess ?? [];
        const allAccess = entry.manifest.infraRequirements?.fileAccessAll ?? false;
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
            {allAccess && (
              <p className="text-xs text-muted-foreground">
                <span className="font-mono">all files</span> (User-Data-Owner): read + write
              </p>
            )}
            {grants.length > 0 && (
              <ul className="text-xs text-muted-foreground flex flex-col gap-0.5">
                {grants.map((g, i) => (
                  <li key={i}>
                    <span className="font-mono">{g.extensions.join(", ")}</span>: {g.access}
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
// Cloud apps section
// ---------------------------------------------------------------------------

function CloudAppsSection({ apps }: { apps: LocalAppEntry[] | null }) {
  const [apiGatewayUrl, setApiGatewayUrl] = useState<string | null>(null);
  const [credError, setCredError] = useState<string | null>(null);
  // The app whose install modal is currently open (null when closed).
  const [installing, setInstalling] = useState<{ appId: string; appName: string; endpoint: string } | null>(null);
  const [credentials, setCredentials] = useState<(STSCredentials & { region?: string }) | null>(null);
  // Apps that completed an install/redeploy this session (drives the badge +
  // Install→Redeploy label). The deployed URL is shown regardless of this.
  const [installedIds, setInstalledIds] = useState<Set<string>>(new Set());

  // Resolve the API Gateway base URL from the persisted cloud config so each
  // app's Open ↗ link (`${apiGatewayUrl}/apps/${appId}/`) survives a reload.
  // Once cloud is set up, showing the link is harmless even before install.
  useEffect(() => {
    (async () => {
      const cfg = await readCloudConfig();
      setApiGatewayUrl(cfg?.apiGatewayUrl ?? null);
    })();
  }, []);

  const handleInstall = async (appId: string, appName: string, endpoint: string) => {
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

    setCredentials({ ...creds, region: cfg.region });
    setInstalling({ appId, appName, endpoint });
  };

  return (
    <div className="rounded-lg border p-5 flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Deploy apps to AWS. Requires cloud infrastructure to be set up and a valid sign-in session.
      </p>

      {credError && (
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{credError}</AlertDescription>
        </Alert>
      )}

      {apps === null && <p className="text-sm text-muted-foreground">Loading…</p>}
      {apps !== null && apps.length === 0 && (
        <p className="text-sm text-muted-foreground">No cloud apps found.</p>
      )}

      {apps?.map((entry) => {
        const name = entry.manifest.name ?? entry.appId;
        // Cloud install is generic: any app discovered with a "cloud" target is
        // installable via the per-appId route, which drives the app's own
        // `bundle` script. No hardcoded installer registry.
        const endpoint = `/api/apps/${entry.appId}/cloud-install`;
        const url = apiGatewayUrl ? `${apiGatewayUrl}/apps/${entry.appId}/` : null;
        const installed = installedIds.has(entry.appId);
        return (
          <div key={entry.appId} className="rounded-md border p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="font-medium">{name}</span>
                <span className="text-xs text-muted-foreground">v{entry.manifest.version ?? "?"}</span>
                {installed && (
                  <Badge variant="secondary" className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                    Installed
                  </Badge>
                )}
              </div>
              <div className="flex gap-2 items-center">
                {url && (
                  <a href={url} target="_blank" rel="noopener noreferrer" className="text-sm underline" title={url}>
                    Open ↗
                  </a>
                )}
                <Button size="sm" onClick={() => handleInstall(entry.appId, name, endpoint)}>
                  {installed ? "Redeploy" : "Install in cloud"}
                </Button>
              </div>
            </div>
            {entry.manifest.description && (
              <p className="text-sm text-muted-foreground">{entry.manifest.description}</p>
            )}
            {url && (
              <p className="text-xs text-muted-foreground break-all">
                URL: <a href={url} target="_blank" rel="noopener noreferrer" className="underline">{url}</a>
              </p>
            )}
          </div>
        );
      })}

      <CloudAppInstallModal
        opened={installing !== null}
        appId={installing?.appId ?? null}
        appName={installing?.appName ?? null}
        endpoint={installing?.endpoint ?? null}
        credentials={credentials}
        onClose={() => { setInstalling(null); setCredentials(null); }}
        onSuccess={() => {
          if (installing) {
            const id = installing.appId;
            setInstalledIds((prev) => new Set(prev).add(id));
          }
        }}
      />
    </div>
  );
}

function CloudAppInstallModal({
  opened,
  appName,
  endpoint,
  credentials,
  onClose,
  onSuccess,
}: {
  opened: boolean;
  appId: string | null;
  appName: string | null;
  endpoint: string | null;
  credentials: STSCredentials | null;
  onClose: () => void;
  onSuccess?: () => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "running" | "success" | "failure">("idle");

  useEffect(() => {
    if (!opened || !credentials || !endpoint) return;

    setLines([]);
    setStatus("running");
    let aborted = false;

    async function run() {
      try {
        const resp = await fetch(endpoint!, {
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
  }, [opened, credentials, endpoint]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dialog open={opened} onOpenChange={(open) => { if (!open && status !== "running") onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Install {appName ?? "app"} in cloud</DialogTitle>
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
  const grants = entry.manifest.infraRequirements?.fileAccess ?? [];
  const allAccess = entry.manifest.infraRequirements?.fileAccessAll ?? false;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-background rounded-lg border shadow-lg max-w-lg w-full flex flex-col gap-4 p-5">
        <h3 className="text-lg font-semibold">
          Install {entry.manifest.name ?? entry.appId}?
        </h3>
        <p className="text-sm text-muted-foreground">
          This app is requesting the following access to your shared data. Other apps with grants on
          the same file types will see records this app creates; records persist if the app is uninstalled.
        </p>

        {allAccess && (
          <div className="text-sm">
            This app is the <span className="font-medium">User-Data-Owner</span>: read + write access to
            <span className="font-mono"> all files</span>, including unclassified ones.
          </div>
        )}

        {grants.length === 0 ? (
          !allAccess && <p className="text-sm">No file-type grants requested.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {grants.map((g, i) => {
              // Per design: any access (read or readwrite) implicitly grants
              // SELECT on the per-category metadata table. metadataWrite adds
              // INSERT/UPDATE on top of that read.
              const dataPermissions = g.access === "readwrite" ? "read + write" : "read";
              const metadataPermissions = g.metadataWrite ? "read + write" : "read";
              return (
                <li key={i} className="border rounded-md p-3 flex flex-col gap-1">
                  <div className="flex items-center gap-2 text-sm flex-wrap">
                    <span className="font-mono">{g.extensions.join(", ")}</span>
                    <Badge variant="secondary" className="text-xs">records: {dataPermissions}</Badge>
                    <Badge variant="secondary" className="text-xs">metadata: {metadataPermissions}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{g.rationale}</p>
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={onApprove}>Approve &amp; Install</Button>
        </div>
      </div>
    </div>
  );
}

