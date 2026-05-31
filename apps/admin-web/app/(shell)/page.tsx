"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  readCloudConfig,
  readCloudCredentials,
  writeCloudCredentials,
  readCognitoSession,
  writeCognitoSession,
  credentialsNearExpiry,
  type CloudConfig,
} from "../../src/lib/cloud-config";
import { CommandOutputModal } from "../../src/components/CommandOutputModal";
import {
  initiateAuth,
  respondNewPasswordChallenge,
  refreshTokens,
  getIdentityPoolCredentials,
  type CognitoConfig,
  type STSCredentials,
} from "../../src/lib/cognito-auth";
import {
  projectFullMonth,
  type ServiceCost,
} from "../../src/lib/cost-usage-report";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TypeSummary {
  record_type: string;
  count: number;
}

interface DataTypesResponse {
  types: TypeSummary[];
  total: number;
}

interface Watch {
  id: string;
  directoryPath: string;
  state: string;
  totalFiles: number;
  syncedFiles: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractEmail(idToken: string): string | null {
  try {
    const payload = JSON.parse(atob(idToken.split(".")[1]));
    return (payload.email as string) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [localRefreshKey, setLocalRefreshKey] = useState(0);
  const bumpAll = () => { setRefreshKey((k) => k + 1); setLocalRefreshKey((k) => k + 1); };

  // Local data server
  const [localOnline, setLocalOnline] = useState<boolean | null>(null);
  const [localTypes, setLocalTypes] = useState<DataTypesResponse | null>(null);
  const [localCognitoConfig, setLocalCognitoConfig] = useState<CognitoConfig | null>(null);
  const [localAuthAuthenticated, setLocalAuthAuthenticated] = useState<boolean | null>(null);
  const [watches, setWatches] = useState<Watch[] | null>(null);
  const [typesExpanded, setTypesExpanded] = useState(false);

  // Remote
  const [cloudConfig, setCloudConfig] = useState<CloudConfig | null | undefined>(undefined);
  const [cognitoSession, setCognitoSession] = useState<{ refreshToken: string; userEmail?: string } | null>(null);
  const [remoteOnline, setRemoteOnline] = useState<boolean | null>(null);
  const [remoteTypes, setRemoteTypes] = useState<DataTypesResponse | null>(null);
  const [remoteTypesExpanded, setRemoteTypesExpanded] = useState(false);

  // Costs
  const [costs, setCosts] = useState<ServiceCost[] | "loading" | "error" | "no-data" | "not-signed-in">("loading");
  const [costProjection, setCostProjection] = useState<ServiceCost[] | null>(null);

  // Add watch form
  const [watchPath, setWatchPath] = useState("");
  const [watchSubmitting, setWatchSubmitting] = useState(false);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [watchSuccess, setWatchSuccess] = useState<string | null>(null);

  // Daemon start/stop loading
  const [daemonLoading, setDaemonLoading] = useState<Record<string, boolean>>({});

  // Command output modal
  const [outputModal, setOutputModal] = useState<{
    commandId: string;
    title: string;
    credentials?: STSCredentials & { region: string };
  } | null>(null);
  const [outputOpen, setOutputOpen] = useState(false);

  // Confirm modal
  const [confirmModal, setConfirmModal] = useState<{
    commandId: string;
    title: string;
    message: string;
    requiresCreds: boolean;
  } | null>(null);

  // Sign-in modal
  const [signInOpen, setSignInOpen] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInNewPassword, setSignInNewPassword] = useState("");
  const [signInConfirmPassword, setSignInConfirmPassword] = useState("");
  const [signInChallenge, setSignInChallenge] = useState<{ session: string } | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signInLoading, setSignInLoading] = useState(false);

  // Poll every 2s while any daemon is starting
  const anyDaemonLoading = Object.values(daemonLoading).some(Boolean);
  useEffect(() => {
    if (!anyDaemonLoading) return;
    const timer = setInterval(() => setLocalRefreshKey((k) => k + 1), 2000);
    return () => clearInterval(timer);
  }, [anyDaemonLoading]);

  useEffect(() => {
    if (daemonLoading["local-data-server"] && localOnline === true) {
      setDaemonLoading((l) => ({ ...l, "local-data-server": false }));
    }
  }, [localOnline]); // eslint-disable-line react-hooks/exhaustive-deps

  async function startDaemon(id: string) {
    // Defense in depth: if the data server is already reachable, refuse to
    // re-spawn it. The current process would fail to bind port 9820 anyway,
    // and the daemon route would clobber the existing pid file in the process.
    if (id === "local-data-server") {
      try {
        const probe = await fetch("http://127.0.0.1:9820/health", { signal: AbortSignal.timeout(1500) });
        if (probe.ok) { setLocalRefreshKey((k) => k + 1); return; }
      } catch { /* not reachable — proceed to start */ }
    }
    setDaemonLoading((l) => ({ ...l, [id]: true }));
    try {
      await fetch("/api/exec/daemon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", id }),
      });
    } catch {
      setDaemonLoading((l) => ({ ...l, [id]: false }));
      return;
    }
    setTimeout(() => {
      setDaemonLoading((l) => ({ ...l, [id]: false }));
      setLocalRefreshKey((k) => k + 1);
    }, 90_000);
  }

  async function stopDaemon(id: string) {
    setDaemonLoading((l) => ({ ...l, [id]: true }));
    try {
      await fetch("/api/exec/daemon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", id }),
      });
      setLocalRefreshKey((k) => k + 1);
    } finally {
      setDaemonLoading((l) => ({ ...l, [id]: false }));
    }
  }

  async function runStream(commandId: string, title: string, requiresCreds: boolean) {
    let credentials: (STSCredentials & { region: string }) | undefined;
    if (requiresCreds) {
      const cfg = await readCloudConfig();
      if (!cfg) return;
      const session = await readCognitoSession();
      if (!session?.refreshToken) return;
      let stored = await readCloudCredentials();
      if (!stored) {
        try {
          const tokens = await refreshTokens(cfg.cognitoConfig, session.refreshToken);
          stored = await getIdentityPoolCredentials(cfg.cognitoConfig, tokens.idToken);
          await writeCloudCredentials(stored);
          await writeCognitoSession({ ...session, refreshToken: tokens.refreshToken });
        } catch {
          return;
        }
      }
      credentials = { ...stored, region: cfg.region };
    }
    setOutputModal({ commandId, title, credentials });
    setOutputOpen(true);
  }

  function openConfirm(commandId: string, title: string, message: string, requiresCreds: boolean) {
    setConfirmModal({ commandId, title, message, requiresCreds });
  }

  // Fetch local server data
  useEffect(() => {
    setLocalOnline(null);
    setLocalTypes(null);
    setWatches(null);
    const controller = new AbortController();

    async function fetchLocal() {
      try {
        const healthResp = await fetch("http://127.0.0.1:9820/health", { signal: controller.signal });
        if (!healthResp.ok) { setLocalOnline(false); return; }
        setLocalOnline(true);
      } catch {
        if (!controller.signal.aborted) setLocalOnline(false);
        return;
      }
      // Server is reachable. Data-bearing endpoints require app-auth headers
      // that admin-web doesn't currently send, so a non-2xx here doesn't mean
      // the server is offline — just that we can't read that view.
      try {
        const [typesResp, watchesResp, configResp, authStatusResp] = await Promise.all([
          fetch("http://127.0.0.1:9820/data/types", { signal: controller.signal }),
          fetch("http://127.0.0.1:9820/watches", { signal: controller.signal }),
          fetch("http://127.0.0.1:9820/config", { signal: controller.signal }),
          fetch("http://127.0.0.1:9820/auth/status", { signal: controller.signal }),
        ]);
        if (typesResp.ok) setLocalTypes(await typesResp.json());
        if (watchesResp.ok) setWatches((await watchesResp.json()).watches);
        if (configResp.ok) {
          const cfg = await configResp.json();
          if (cfg.cognitoConfig) setLocalCognitoConfig(cfg.cognitoConfig as CognitoConfig);
        }
        if (authStatusResp.ok) {
          const status = await authStatusResp.json();
          setLocalAuthAuthenticated(status.authenticated as boolean);
        }
      } catch { /* leave per-section state null */ }
    }

    fetchLocal();
    return () => controller.abort();
  }, [refreshKey, localRefreshKey]);

  // Read cloud config + cognito session
  useEffect(() => {
    readCloudConfig().then(setCloudConfig);
    readCognitoSession().then(setCognitoSession);
  }, [refreshKey]);

  // Fetch remote data
  useEffect(() => {
    setRemoteOnline(null);
    setRemoteTypes(null);
    async function fetchRemote() {
      const cfg = await readCloudConfig();
      const session = await readCognitoSession();
      if (!cfg?.apiGatewayUrl || !session?.refreshToken) return;
      try {
        const tokens = await refreshTokens(cfg.cognitoConfig, session.refreshToken);
        const resp = await fetch(`${cfg.apiGatewayUrl}/data/types`, {
          signal: AbortSignal.timeout(8000),
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        });
        if (resp.ok) { setRemoteTypes(await resp.json()); setRemoteOnline(true); }
        else setRemoteOnline(false);
      } catch { setRemoteOnline(false); }
    }
    fetchRemote();
  }, [refreshKey]);

  // Fetch costs
  useEffect(() => {
    setCosts("loading");
    setCostProjection(null);
    async function fetchCosts() {
      const cfg = await readCloudConfig();
      if (!cfg || !cfg.apiGatewayUrl) { setCosts("no-data"); return; }
      const session = await readCognitoSession();
      let creds: STSCredentials | null = await readCloudCredentials();
      if (!creds || credentialsNearExpiry(creds)) {
        if (!session?.refreshToken) { setCosts("not-signed-in"); return; }
        try {
          const tokens = await refreshTokens(cfg.cognitoConfig, session.refreshToken);
          creds = await getIdentityPoolCredentials(cfg.cognitoConfig, tokens.idToken);
          await writeCloudCredentials(creds);
          await writeCognitoSession({ ...session, refreshToken: tokens.refreshToken });
        } catch { setCosts("not-signed-in"); return; }
      }
      try {
        const resp = await fetch("/api/costs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ credentials: creds, stackPrefix: cfg.stackPrefix }),
        });
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({})) as { error?: string; code?: string };
          const isAuthError = body.code === "InvalidClientTokenId" || body.code === "ExpiredTokenException";
          setCosts(isAuthError ? "not-signed-in" : "error");
          return;
        }
        const { costs: mtd } = await resp.json() as { costs: ServiceCost[] | null };
        if (mtd === null) { setCosts("no-data"); }
        else { setCosts(mtd); setCostProjection(projectFullMonth(mtd)); }
      } catch { setCosts("error"); }
    }
    fetchCosts();
  }, [refreshKey]);

  // Sign-in handlers
  async function handleSignIn() {
    const cognitoConfig = localCognitoConfig ?? cloudConfig?.cognitoConfig;
    if (!cognitoConfig) return;
    setSignInLoading(true);
    setSignInError(null);
    try {
      const result = await initiateAuth(cognitoConfig, signInEmail, signInPassword);
      if (result.tokens) {
        const email = extractEmail(result.tokens.idToken);
        await fetch("http://127.0.0.1:9820/auth/tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken: result.tokens.idToken, refreshToken: result.tokens.refreshToken }),
        });
        await writeCognitoSession({ refreshToken: result.tokens.refreshToken, userEmail: email ?? undefined });
        setSignInOpen(false);
        bumpAll();
      } else if (result.challengeName === "NEW_PASSWORD_REQUIRED" && result.session) {
        setSignInChallenge({ session: result.session });
      } else {
        setSignInError("Unexpected response from Cognito");
      }
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setSignInLoading(false);
    }
  }

  async function handleNewPassword() {
    const cognitoConfig = localCognitoConfig ?? cloudConfig?.cognitoConfig;
    if (!cognitoConfig || !signInChallenge) return;
    if (signInNewPassword !== signInConfirmPassword) { setSignInError("Passwords do not match"); return; }
    setSignInLoading(true);
    setSignInError(null);
    try {
      const tokens = await respondNewPasswordChallenge(cognitoConfig, signInChallenge.session, signInEmail, signInNewPassword);
      const email = extractEmail(tokens.idToken);
      await fetch("http://127.0.0.1:9820/auth/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: tokens.idToken, refreshToken: tokens.refreshToken }),
      });
      await writeCognitoSession({ refreshToken: tokens.refreshToken, userEmail: email ?? undefined });
      setSignInOpen(false);
      bumpAll();
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : "Failed to set new password");
    } finally {
      setSignInLoading(false);
    }
  }

  function openSignIn() {
    setSignInEmail(""); setSignInPassword(""); setSignInNewPassword(""); setSignInConfirmPassword("");
    setSignInChallenge(null); setSignInError(null); setSignInOpen(true);
  }

  // Watch handlers
  async function handleAddWatch() {
    const path = watchPath.trim();
    if (!path) return;
    setWatchError(null); setWatchSuccess(null);
    const expanded = path.startsWith("~/") ? path.replace("~", "") : path;
    const duplicate = watches?.some((w) => w.directoryPath === path || w.directoryPath.endsWith(expanded));
    if (duplicate) { setWatchError("A watch for this directory already exists."); return; }
    setWatchSubmitting(true);
    try {
      const resp = await fetch("http://127.0.0.1:9820/watches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directoryPath: path, recursive: true }),
      });
      const data = await resp.json();
      if (resp.ok) {
        setWatchPath(""); setWatchSuccess(`Watch started: ${data.watch?.directoryPath ?? path}`);
        const wResp = await fetch("http://127.0.0.1:9820/watches");
        if (wResp.ok) setWatches((await wResp.json()).watches);
      } else {
        setWatchError(data.error ?? "Failed to add watch.");
      }
    } catch { setWatchError("Could not reach the data server."); }
    finally { setWatchSubmitting(false); }
  }

  async function handleRemoveWatch(id: string) {
    try {
      await fetch(`http://127.0.0.1:9820/watches/${id}`, { method: "DELETE" });
      setWatches((ws) => ws?.filter((w) => w.id !== id) ?? null);
    } catch { /* server offline */ }
  }

  const signedIn = localAuthAuthenticated ?? false;
  const authStale = signedIn && !cognitoSession?.userEmail;

  async function handleSignOut() {
    await fetch("http://127.0.0.1:9820/auth/logout", { method: "POST" }).catch(() => {});
    bumpAll();
  }

  return (
    <div className="max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <Button variant="outline" size="sm" onClick={bumpAll}>Refresh</Button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
        {/* ── LOCAL ── */}
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-medium">Local</h2>

          <div className="rounded-lg border p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">Data Server</h3>
              <div className="flex items-center gap-2">
                <StatusBadge online={localOnline} />
                {localOnline === true && (
                  <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive"
                    disabled={!!daemonLoading["local-data-server"]}
                    onClick={() => stopDaemon("local-data-server")}
                  >
                    {daemonLoading["local-data-server"] && <span className="mr-1 size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
                    Stop
                  </Button>
                )}
              </div>
            </div>

            {localOnline === false && (
              <div className="flex flex-col gap-3">
                <Alert>
                  <AlertTitle>Data server not running</AlertTitle>
                  <AlertDescription>The local data server must be running for local features to work.</AlertDescription>
                </Alert>
                <div className="flex justify-end">
                  <Button size="sm" variant="outline"
                    disabled={!!daemonLoading["local-data-server"]}
                    onClick={() => startDaemon("local-data-server")}
                  >
                    {daemonLoading["local-data-server"] && <span className="mr-1 size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
                    Start
                  </Button>
                </div>
              </div>
            )}

            {localOnline === true && (
              <div className="flex flex-col gap-3">
                {localTypes && (
                  <>
                    <button
                      className="text-sm text-left underline decoration-dotted underline-offset-2"
                      onClick={() => setTypesExpanded((e) => !e)}
                    >
                      {localTypes.types.length} type{localTypes.types.length !== 1 ? "s" : ""} registered
                      &nbsp;·&nbsp;
                      {localTypes.total} record{localTypes.total !== 1 ? "s" : ""} total
                    </button>

                    {typesExpanded && (
                      <div className="flex flex-col gap-1 pl-2">
                        {localTypes.types.length === 0 ? (
                          <span className="text-xs text-muted-foreground">No records yet</span>
                        ) : (
                          localTypes.types.map((t) => (
                            <div key={t.record_type} className="flex items-center justify-between">
                              <code className="font-mono text-xs">{t.record_type}</code>
                              <Badge variant="secondary" className="text-xs">{t.count}</Badge>
                            </div>
                          ))
                        )}
                      </div>
                    )}

                    <Separator />
                  </>
                )}

                <p className="text-xs font-medium text-muted-foreground">Watches</p>

                {watches && watches.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    {watches.map((w) => (
                      <div key={w.id} className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className="text-sm truncate flex-1">{w.directoryPath}</span>
                          <Badge variant="outline" className="text-xs shrink-0">{w.state}</Badge>
                          <span className="text-xs text-muted-foreground shrink-0">{w.syncedFiles}/{w.totalFiles}</span>
                        </div>
                        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive shrink-0"
                          onClick={() => handleRemoveWatch(w.id)}
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="text-sm text-muted-foreground">No watches configured</span>
                )}

                <div className="flex gap-2">
                  <Input
                    placeholder="/path/to/directory or ~/Photos"
                    className="text-sm h-8"
                    value={watchPath}
                    onChange={(e) => { setWatchPath(e.currentTarget.value); setWatchError(null); setWatchSuccess(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") handleAddWatch(); }}
                  />
                  <Button size="sm" onClick={handleAddWatch} disabled={watchSubmitting || !watchPath.trim()}>
                    {watchSubmitting && <span className="mr-1 size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
                    Add
                  </Button>
                </div>
                {watchError && <p className="text-xs text-destructive">{watchError}</p>}
                {watchSuccess && <p className="text-xs text-green-600 dark:text-green-400">{watchSuccess}</p>}
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive"
              onClick={() => openConfirm("reset-local-data", "Clear local data", "This will permanently delete all local object files, the SQLite database, and watch configs.", false)}
            >
              Clear local data
            </Button>
          </div>
        </div>

        {/* ── REMOTE ── */}
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-medium">Remote</h2>

          {cloudConfig === undefined ? (
            <div className="rounded-lg border p-4 flex flex-col gap-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-48" />
            </div>
          ) : cloudConfig === null ? (
            <div className="rounded-lg border p-6 flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">Cloud is not set up yet.</p>
              <Button asChild variant="outline" size="sm" className="w-fit">
                <Link href="/cloud-setup">Set up cloud →</Link>
              </Button>
            </div>
          ) : (
            <>
              <div className="rounded-lg border p-4 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium">Data Server</h3>
                  {cloudConfig.apiGatewayUrl ? (
                    <StatusBadge online={remoteOnline} />
                  ) : (
                    <Badge variant="secondary" className="text-xs">Not configured</Badge>
                  )}
                </div>

                {!cloudConfig.apiGatewayUrl ? (
                  <p className="text-sm text-muted-foreground">Complete cloud setup to enable remote features.</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {remoteOnline === true && remoteTypes && (
                      <>
                        <button
                          className="text-sm text-left underline decoration-dotted underline-offset-2"
                          onClick={() => setRemoteTypesExpanded((e) => !e)}
                        >
                          {remoteTypes.types.length} type{remoteTypes.types.length !== 1 ? "s" : ""} registered
                          &nbsp;·&nbsp;
                          {remoteTypes.total} record{remoteTypes.total !== 1 ? "s" : ""} total
                        </button>
                        {remoteTypesExpanded && (
                          <div className="flex flex-col gap-1 pl-2">
                            {remoteTypes.types.map((t) => (
                              <div key={t.record_type} className="flex items-center justify-between">
                                <code className="font-mono text-xs">{t.record_type}</code>
                                <Badge variant="secondary" className="text-xs">{t.count}</Badge>
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline"
                        onClick={() => openConfirm("local-deploy", "Redeploy from local", "This will run pulumi up using your current local code. The process may take several minutes.", true)}
                      >
                        Redeploy from local
                      </Button>
                      <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive"
                        onClick={() => openConfirm("reset-cloud-data", "Clear all cloud data", "This will permanently delete all files from S3 and all records from the Aurora DSQL database.", true)}
                      >
                        Clear all cloud data
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              <div className="rounded-lg border p-4 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium">Authentication</h3>
                  {signedIn ? (
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="secondary"
                        className={cn("text-xs", authStale
                          ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200"
                          : "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200")}
                      >
                        {authStale ? "Stale session" : "Signed in"}
                      </Badge>
                      {cognitoSession?.userEmail && (
                        <span className="text-sm text-muted-foreground">{cognitoSession.userEmail}</span>
                      )}
                      <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={handleSignOut}>
                        Sign out
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-xs">Not signed in</Badge>
                      {(localCognitoConfig ?? cloudConfig.cognitoConfig) && (
                        <Button size="sm" variant="outline" onClick={openSignIn}>Sign in</Button>
                      )}
                    </div>
                  )}
                </div>
                {authStale && (
                  <Alert>
                    <AlertTitle>Auth config may be invalid</AlertTitle>
                    <AlertDescription>
                      The local data server has a stored session but no confirmed username — this can happen after recreating the bootstrap stack.
                      Sign out to clear the stale session, then sign in again.
                    </AlertDescription>
                  </Alert>
                )}
              </div>

              <div className="rounded-lg border p-4">
                <h3 className="font-medium mb-3">Costs</h3>
                {costs === "loading" ? (
                  <div className="flex flex-col gap-2">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-3/4" />
                  </div>
                ) : costs === "not-signed-in" ? (
                  <p className="text-sm text-muted-foreground">Sign in to view cost data.</p>
                ) : costs === "error" ? (
                  <p className="text-sm text-muted-foreground">Could not load cost data.</p>
                ) : costs === "no-data" ? (
                  <p className="text-sm text-muted-foreground">Cost report configured — data arrives within 24 hours.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Service</TableHead>
                        <TableHead className="text-right">Month-to-date</TableHead>
                        <TableHead className="text-right">Projected</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {costs.map((row) => {
                        const proj = costProjection?.find((p) => p.service === row.service);
                        return (
                          <TableRow key={row.service}>
                            <TableCell>{row.service}</TableCell>
                            <TableCell className="text-right">${row.amount.toFixed(2)}</TableCell>
                            <TableCell className="text-right text-muted-foreground">${(proj?.amount ?? 0).toFixed(2)}</TableCell>
                          </TableRow>
                        );
                      })}
                      <TableRow className="font-medium">
                        <TableCell>Total</TableCell>
                        <TableCell className="text-right">${costs.reduce((s, r) => s + r.amount, 0).toFixed(2)}</TableCell>
                        <TableCell className="text-right text-muted-foreground">${(costProjection ?? []).reduce((s, r) => s + r.amount, 0).toFixed(2)}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Sign-in dialog */}
      <Dialog open={signInOpen} onOpenChange={(open) => { setSignInOpen(open); if (!open) setSignInChallenge(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Sign in to cloud</DialogTitle>
          </DialogHeader>
          {!signInChallenge ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">Email</label>
                <Input value={signInEmail} onChange={(e) => setSignInEmail(e.currentTarget.value)} disabled={signInLoading} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">Password</label>
                <Input type="password" value={signInPassword}
                  onChange={(e) => setSignInPassword(e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSignIn(); }}
                  disabled={signInLoading}
                />
              </div>
              {signInError && <Alert variant="destructive"><AlertDescription>{signInError}</AlertDescription></Alert>}
              <Button onClick={handleSignIn} disabled={signInLoading} className="w-full">
                {signInLoading && <span className="mr-2 size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
                Sign in
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">This account requires a new permanent password.</p>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">New password</label>
                <Input type="password" value={signInNewPassword} onChange={(e) => setSignInNewPassword(e.currentTarget.value)} disabled={signInLoading} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">Confirm new password</label>
                <Input type="password" value={signInConfirmPassword}
                  onChange={(e) => setSignInConfirmPassword(e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleNewPassword(); }}
                  disabled={signInLoading}
                />
              </div>
              {signInError && <Alert variant="destructive"><AlertDescription>{signInError}</AlertDescription></Alert>}
              <Button onClick={handleNewPassword} disabled={signInLoading} className="w-full">
                {signInLoading && <span className="mr-2 size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
                Set password &amp; sign in
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Command output modal */}
      <CommandOutputModal
        opened={outputOpen}
        onClose={() => { setOutputOpen(false); setOutputModal(null); }}
        commandId={outputModal?.commandId ?? null}
        credentials={outputModal?.credentials}
        title={outputModal?.title ?? ""}
      />

      {/* Confirm dialog */}
      <Dialog open={confirmModal !== null} onOpenChange={(open) => { if (!open) setConfirmModal(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{confirmModal?.title ?? ""}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{confirmModal?.message}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmModal(null)}>Cancel</Button>
            <Button variant="destructive"
              onClick={() => {
                const m = confirmModal;
                setConfirmModal(null);
                if (m) runStream(m.commandId, m.title, m.requiresCreds);
              }}
            >
              Confirm
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ online }: { online: boolean | null }) {
  if (online === null) return <span className="size-4 animate-spin rounded-full border-2 border-border border-t-foreground" />;
  return (
    <Badge
      variant="secondary"
      className={cn("text-xs", online
        ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
        : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200")}
    >
      {online ? "Online" : "Offline"}
    </Badge>
  );
}