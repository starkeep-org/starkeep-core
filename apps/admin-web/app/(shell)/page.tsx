"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import Link from "next/link";
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
import {
  readCloudConfig,
  readCloudCredentials,
  writeCloudCredentials,
  readCognitoSession,
  writeCognitoSession,
  clearCloudCredentials,
  credentialsNearExpiry,
  type CloudConfig,
  type CognitoSession,
} from "../../src/lib/cloud-config";
import { AppCard } from "../../src/components/AppCard";
import { CloudDataServerStatus } from "../../src/components/CloudDataServerStatus";
import { StatusBadge } from "../../src/components/StatusBadge";
import { APPS_CHANGED_EVENT } from "../../src/components/AppDiscovery";
import { LocalDriveSection } from "../../src/components/LocalDriveSection";
import { LocalAppsSection } from "../../src/components/LocalAppsSection";
import { CloudAppsSection } from "../../src/components/CloudAppsSection";
import { PairedDevicesSection } from "../../src/components/PairedDevicesSection";
import { LocalFoldersModal, type Watch } from "../../src/components/LocalFoldersModal";
import { targetsOf, type LocalAppEntry } from "../../src/lib/app-types";
import {
  initiateAuth,
  respondNewPasswordChallenge,
  refreshTokens,
  getIdentityPoolCredentials,
  extractEmailFromIdToken,
  type CognitoConfig,
  type STSCredentials,
} from "../../src/lib/cognito-auth";
import {
  projectFullMonth,
  type ServiceCost,
} from "../../src/lib/cost-usage-report";
import { localDataServerUrl } from "../../src/lib/runtime-config";
import { ACTION_OCCASIONAL, ACTION_START } from "../../src/lib/action-colors";

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [localRefreshKey, setLocalRefreshKey] = useState(0);

  // Discovered apps (from /api/apps/list). Membership in the local vs. cloud
  // sections is derived from each manifest's `targets` (default ["local"]).
  const [apps, setApps] = useState<LocalAppEntry[] | null>(null);
  const [appsError, setAppsError] = useState<string | null>(null);
  const refreshApps = useCallback(async () => {
    setAppsError(null);
    try {
      const res = await fetch("/api/apps/list");
      if (!res.ok) throw new Error(`list failed: ${res.status}`);
      const body = (await res.json()) as { apps: LocalAppEntry[] };
      setApps(body.apps);
    } catch (err) {
      setAppsError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const bumpAll = () => { setRefreshKey((k) => k + 1); setLocalRefreshKey((k) => k + 1); refreshApps(); };

  // Local data server
  const [localOnline, setLocalOnline] = useState<boolean | null>(null);
  const [localCognitoConfig, setLocalCognitoConfig] = useState<CognitoConfig | null>(null);
  const [watches, setWatches] = useState<Watch[] | null>(null);

  // Remote
  const [cloudConfig, setCloudConfig] = useState<CloudConfig | null | undefined>(undefined);
  const [cognitoSession, setCognitoSession] = useState<CognitoSession | null>(null);

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

  // Watch management modal
  const [foldersOpen, setFoldersOpen] = useState(false);

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
        const base = await localDataServerUrl();
        const probe = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
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

  // Fetch local server data
  useEffect(() => {
    setLocalOnline(null);
    setWatches(null);
    const controller = new AbortController();

    async function fetchLocal() {
      const base = await localDataServerUrl();
      try {
        const healthResp = await fetch(`${base}/health`, { signal: controller.signal });
        if (!healthResp.ok) { setLocalOnline(false); return; }
        setLocalOnline(true);
      } catch {
        if (!controller.signal.aborted) setLocalOnline(false);
        return;
      }
      // Server is reachable. /watches and /config are admin endpoints exempt
      // from app-auth. The per-app /data/* routes require an HMAC identity
      // admin-web doesn't have, so we don't probe them from here.
      try {
        const [watchesResp, configResp] = await Promise.all([
          fetch(`${base}/watches`, { signal: controller.signal }),
          fetch(`${base}/config`, { signal: controller.signal }),
        ]);
        if (watchesResp.ok) setWatches((await watchesResp.json()).watches);
        if (configResp.ok) {
          const cfg = await configResp.json();
          if (cfg.cognitoConfig) setLocalCognitoConfig(cfg.cognitoConfig as CognitoConfig);
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

  // Initial app-list fetch (also re-run by bumpAll via refreshApps).
  useEffect(() => { refreshApps(); }, [refreshApps]);

  // The Discover apps button lives in the shell header, outside this tree, so
  // it announces a changed directory list on `window` rather than calling back.
  useEffect(() => {
    const onChanged = () => { refreshApps(); };
    window.addEventListener(APPS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(APPS_CHANGED_EVENT, onChanged);
  }, [refreshApps]);

  const localApps = apps === null ? null : apps.filter((a) => targetsOf(a).includes("local"));
  const cloudApps = apps === null ? null : apps.filter((a) => targetsOf(a).includes("cloud"));

  // Watch totals, summed across folders from the same per-watch counters the
  // folder list shows.
  const watchCount = watches?.length ?? 0;
  const syncedFiles = watches?.reduce((n, w) => n + w.syncedFiles, 0) ?? 0;
  const totalFiles = watches?.reduce((n, w) => n + w.totalFiles, 0) ?? 0;

  // Deployed once the cloud data server install has written its gateway URL.
  const cloudDeployed = !!cloudConfig?.apiGatewayUrl;

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
          body: JSON.stringify({ credentials: creds, stackPrefix: cfg.stackPrefix, region: cfg.region }),
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
        const email = extractEmailFromIdToken(result.tokens.idToken);
        await fetch(`${await localDataServerUrl()}/auth/tokens`, {
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
      const email = extractEmailFromIdToken(tokens.idToken);
      await fetch(`${await localDataServerUrl()}/auth/tokens`, {
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
      const base = await localDataServerUrl();
      const resp = await fetch(`${base}/watches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directoryPath: path, recursive: true }),
      });
      const data = await resp.json();
      if (resp.ok) {
        setWatchPath(""); setWatchSuccess(`Watch started: ${data.watch?.directoryPath ?? path}`);
        const wResp = await fetch(`${base}/watches`);
        if (wResp.ok) setWatches((await wResp.json()).watches);
      } else {
        setWatchError(data.error ?? "Failed to add watch.");
      }
    } catch { setWatchError("Could not reach the data server."); }
    finally { setWatchSubmitting(false); }
  }

  async function handleRemoveWatch(id: string) {
    try {
      await fetch(`${await localDataServerUrl()}/watches/${id}`, { method: "DELETE" });
      setWatches((ws) => ws?.filter((w) => w.id !== id) ?? null);
    } catch { /* server offline */ }
  }

  async function handleSignOut() {
    await fetch(`${await localDataServerUrl()}/auth/logout`, { method: "POST" }).catch(() => {});
    await clearCloudCredentials();
    setCognitoSession(null);
    bumpAll();
  }

  return (
    <div className="min-h-full bg-surface p-6">
      {appsError && (
        <Alert variant="destructive" className="mb-6 max-w-7xl">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{appsError}</AlertDescription>
        </Alert>
      )}

      <div className="grid max-w-7xl grid-cols-1 xl:grid-cols-2 gap-6 items-start">
        {/* ── LOCAL ── */}
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-medium">Local</h2>

          <LocalAppsSection
            apps={localApps}
            refresh={refreshApps}
            leading={
              <>
                <AppCard
                  name="Data Server"
                  badges={
                    <>
                      <Badge variant="secondary" className="text-xs">Built-in</Badge>
                      <StatusBadge online={localOnline} />
                    </>
                  }
                  description={
                    localOnline === false ? (
                      "The local data server must be running for local features to work."
                    ) : localOnline === true ? (
                      // The folder list itself lives in the modal — the card reports
                      // only how much is watched, so its height stays fixed.
                      <>
                        <span className="block">Indexes and syncs local files.</span>
                        {watches === null ? (
                          <Skeleton className="h-4 w-40" />
                        ) : watchCount === 0 ? (
                          "No folders are watched yet."
                        ) : (
                          `${watchCount} ${watchCount === 1 ? "folder" : "folders"} · ${syncedFiles}/${totalFiles} files`
                        )}
                      </>
                    ) : undefined
                  }
                  actions={
                    localOnline === true
                      ? [
                          { label: "Storage…", href: "/storage" },
                          {
                            label: "Stop",
                            onSelect: () => stopDaemon("local-data-server"),
                            disabled: !!daemonLoading["local-data-server"],
                            destructive: true,
                          },
                        ]
                      : []
                  }
                  primary={
                    localOnline === true ? (
                      <Button
                        size="sm"
                        className={ACTION_OCCASIONAL}
                        onClick={() => setFoldersOpen(true)}
                      >
                        {watchCount === 0 ? "Add Local Folder" : "Manage Local Folders"}
                      </Button>
                    ) : localOnline === false ? (
                      <Button
                        size="sm"
                        className={ACTION_START}
                        disabled={!!daemonLoading["local-data-server"]}
                        onClick={() => startDaemon("local-data-server")}
                      >
                        {daemonLoading["local-data-server"] && <span className="mr-1 size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
                        Start Data Server
                      </Button>
                    ) : undefined
                  }
                />
                <LocalDriveSection />
              </>
            }
          />
        </div>

        {/* ── CLOUD ──
            Until a deployment exists there is nothing to report and exactly one
            thing to do, so the column carries the deploy button alone. Once the
            cloud is up the button retires into the Data Server card's menu,
            where managing a deployment sits on the deployment it manages. */}
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-medium">Cloud</h2>

          {cloudConfig === undefined ? (
            <div className="w-76 max-w-full rounded-xl p-4 flex flex-col gap-2 ring-1 ring-foreground/10">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-48" />
            </div>
          ) : !cloudDeployed ? (
            <div>
              {/* With no deployment yet, deploying is what brings the cloud up,
                  so it wears the dark green of a start action. */}
              <Button asChild size="sm" className={ACTION_START}>
                <Link href="/cloud-setup">Deploy Starkeep Cloud</Link>
              </Button>
            </div>
          ) : (
            <>
              <CloudAppsSection
                apps={cloudApps}
                leading={
                  <CloudDataServerStatus
                    cloudConfig={cloudConfig}
                    cognitoSession={cognitoSession}
                    refreshKey={refreshKey}
                    onSignIn={openSignIn}
                    onSignOut={handleSignOut}
                  />
                }
              />

              <PairedDevicesSection />

              {/* The cloud Data Server card's View Costs button targets this. */}
              <div id="costs" className="flex flex-col gap-2 scroll-mt-4">
                <h3 className="font-medium">Costs</h3>
                {/* The report bills the whole AWS account, not the stack, so a
                    number here can come from something Starkeep never created. */}
                <p className="text-xs text-muted-foreground">
                  Includes both Starkeep and non-Starkeep service costs.
                </p>

                <div className="rounded-lg border p-4">
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

      {/* Local folders */}
      <LocalFoldersModal
        open={foldersOpen}
        onOpenChange={(open) => {
          setFoldersOpen(open);
          if (!open) { setWatchError(null); setWatchSuccess(null); }
        }}
        watches={watches}
        path={watchPath}
        onPathChange={(v) => { setWatchPath(v); setWatchError(null); setWatchSuccess(null); }}
        onAdd={handleAddWatch}
        onRemove={handleRemoveWatch}
        submitting={watchSubmitting}
        error={watchError}
        success={watchSuccess}
      />
    </div>
  );
}

