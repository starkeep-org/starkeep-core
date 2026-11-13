import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AppCard, AppCardGrid, type AppCardAction } from "@/components/AppCard";
import { APPS_CHANGED_EVENT } from "@/components/AppDiscovery";
import { CommandOutput } from "@/components/CommandOutput";
import { ConsentDialog } from "@/components/ConsentDialog";
import { useAppUpdate } from "@/components/AppUpdate";
import { runInstallStream } from "@/lib/install-stream-client";
import { ACTION_OCCASIONAL, ACTION_OPEN, ACTION_START } from "@/lib/action-colors";
import {
  type DaemonStatus,
  type DependencyPlan,
  type InstallStep,
  type LocalAppEntry,
} from "@/lib/app-types";

export function LocalAppsSection({
  apps,
  refresh,
  localOnline,
  leading,
}: {
  apps: LocalAppEntry[] | null;
  refresh: () => Promise<void>;
  // Whether the local data server is reachable, owned by the Dashboard so the
  // Data Server card and these cards cannot disagree. Installs route through
  // it, so the Install button stays disabled until it is online. null = not
  // yet probed.
  localOnline: boolean | null;
  /** Cards rendered ahead of the discovered apps — the built-in Drive. */
  leading?: ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  // An app whose Start found its recorded port held by another program. The
  // alert offers to move the app to another port.
  const [portInUse, setPortInUse] = useState<{ appId: string; port: number } | null>(null);
  const [pendingConsent, setPendingConsent] = useState<LocalAppEntry | null>(null);
  const [busyAppId, setBusyAppId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<Record<string, DaemonStatus>>({});
  // App whose install-step ledger is currently displayed (null when closed).
  const [stepsOpenFor, setStepsOpenFor] = useState<string | null>(null);
  // Why the last install failed, shown in the step-ledger dialog that the
  // failure opens. Cleared when the dialog closes.
  const [installFailure, setInstallFailure] = useState<InstallFailure | null>(null);
  // A command Install would not run, for the user to run by hand.
  const [notice, setNotice] = useState<string | null>(null);
  // The dependency install Install runs before it registers an app.
  const [depsRun, setDepsRun] = useState<{
    name: string;
    display: string;
    lines: string[];
    status: "running" | "failure";
  } | null>(null);
  // Per-app pending transition. We keep this set until the polled status
  // reflects the target state (running for "start", not-running for "stop"),
  // so the spinner survives the first poll round.
  const [pending, setPending] = useState<Record<string, "start" | "stop" | undefined>>({});
  const refreshStatus = useCallback(async (appIds: string[]) => {
    const entries = await Promise.all(
      appIds.map(async (id) => {
        try {
          const res = await fetch(`/api/exec/daemon/status?id=${encodeURIComponent(id)}`);
          if (!res.ok) return [id, { running: false }] as const;
          return [id, (await res.json()) as DaemonStatus] as const;
        } catch {
          return [id, { running: false }] as const;
        }
      }),
    );
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
        } catch {
          /* keep s as not-running and retry */
        }
        setRunStatus((prev) => ({ ...prev, [appId]: s }));
        if ((want === "start" && s.running) || (want === "stop" && !s.running)) return s;
      }
      return null;
    },
    [],
  );

  // `reassignPort` moves the app off a recorded port another program holds.
  const handleStart = async (appId: string, reassignPort = false) => {
    setPending((p) => ({ ...p, [appId]: "start" }));
    setPortInUse(null);
    try {
      const res = await fetch("/api/exec/daemon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start",
          id: appId,
          ...(reassignPort ? { reassignPort: true } : {}),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
          reason?: string;
          port?: number;
        } | null;
        if (data?.reason === "port-in-use" && typeof data.port === "number") {
          setPortInUse({ appId, port: data.port });
          return;
        }
        throw new Error(data?.error ?? `start failed: ${res.status}`);
      }
      const final = await waitForTransition(appId, "start");
      if (!final) setError(`${appId} did not come online within 20s`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending((p) => {
        const n = { ...p };
        delete n[appId];
        return n;
      });
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
      setPending((p) => {
        const n = { ...p };
        delete n[appId];
        return n;
      });
    }
  };

  // Resolves true once the app is installed from its folder.
  const handleApprove = async (entry: LocalAppEntry): Promise<boolean> => {
    setPendingConsent(null);
    setBusyAppId(entry.appId);
    setError(null);
    // A failed install opens the step ledger with the reason on top, so the
    // operator sees the error and the step the installer stopped at together.
    const fail = (failure: Omit<InstallFailure, "appId">) => {
      setInstallFailure({ appId: entry.appId, ...failure });
      setStepsOpenFor(entry.appId);
    };
    try {
      if (!(await installDependencies(entry))) return false;
      const res = await fetch("/api/apps/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The manifest the consent or update dialog showed. The route
        // installs only when the folder still holds it.
        body: JSON.stringify({
          appId: entry.appId,
          approvedManifest: entry.folderManifest ?? entry.manifest,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
          details?: string[];
        } | null;
        fail({ error: data?.error ?? `Install failed: ${res.status}`, details: data?.details });
        return false;
      }
      // A reinstall stops a running app, so its status changes too.
      await Promise.all([refresh(), refreshStatus([entry.appId])]);
      return true;
    } catch (err) {
      fail({ error: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      setBusyAppId(null);
    }
  };

  const handleUninstall = async (entry: LocalAppEntry) => {
    // Uninstall drops the app's own tables and files on this machine, and
    // writes no tombstones, so the deletion stays here. Shared records stay.
    const name = entry.manifest.name ?? entry.appId;
    if (
      !confirm(
        `Uninstall ${name}? This deletes ${name}'s own data on this machine: its tables and files. Reinstalling may not bring it back. Records it shared with other apps stay.`,
      )
    )
      return;
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

  // Install the app's dependencies with the approved command, streaming its
  // output. False when the command ran and failed: the install stops there.
  // A command off the approved list does not run; the notice names it, and
  // Start's dependency check catches what it would have installed.
  const installDependencies = async (entry: LocalAppEntry): Promise<boolean> => {
    const name = entry.manifest.name ?? entry.appId;
    const endpoint = `/api/apps/${encodeURIComponent(entry.appId)}/dependencies`;
    setNotice(null);
    const planRes = await fetch(endpoint);
    if (!planRes.ok) {
      const data = (await planRes.json().catch(() => null)) as { error?: string } | null;
      setError(data?.error ?? `dependency check failed: ${planRes.status}`);
      return false;
    }
    const plan = (await planRes.json()) as DependencyPlan;
    if (plan.kind === "skip") return true;
    if (plan.kind === "refused") {
      setNotice(
        `Install did not run \`${plan.display}\`: ${plan.reason} Run it yourself in ${plan.cwd} before you start ${name}.`,
      );
      return true;
    }
    setDepsRun({ name, display: plan.display, lines: [], status: "running" });
    const outcome = await runInstallStream(
      endpoint,
      {},
      {
        onLine: (line) =>
          setDepsRun((run) => (run ? { ...run, lines: [...run.lines, line] } : run)),
      },
    );
    if (outcome.kind === "done") {
      // Success needs no reading; the output stays up only to explain a failure.
      setDepsRun(null);
      return true;
    }
    setDepsRun((run) =>
      run ? { ...run, status: "failure", lines: [...run.lines, `Error: ${outcome.message}`] } : run,
    );
    return false;
  };

  // The update flow that Start shares with the cloud card's Redeploy. It
  // reinstalls and starts through these handlers, so their progress and
  // failure dialogs stay here. The ref keeps the handlers on this render's
  // state.
  const update = useAppUpdate();
  const handlers = useRef({ handleApprove, handleStart, runStatus });
  handlers.current = { handleApprove, handleStart, runStatus };
  const { registerLocal } = update;
  useEffect(() => {
    registerLocal({
      reinstall: (entry) => handlers.current.handleApprove(entry),
      start: (appId) => handlers.current.handleStart(appId),
      isRunning: (appId) => handlers.current.runStatus[appId]?.running === true,
    });
    return () => registerLocal(null);
  }, [registerLocal]);

  // Hide core's example app by removing its folder from Discover apps.
  const handleHide = async (entry: LocalAppEntry) => {
    const name = entry.manifest.name ?? entry.appId;
    if (
      !confirm(`Hide the ${name}? To show it again, add ${entry.configuredDir} in Discover apps.`)
    )
      return;
    setError(null);
    try {
      const res = await fetch("/api/config");
      if (!res.ok) throw new Error(`config load failed: ${res.status}`);
      const body = (await res.json()) as { config: { appParentDirs?: string[] } | null };
      const dirs = body.config?.appParentDirs ?? [];
      const saved = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appParentDirs: dirs.filter((d) => d !== entry.configuredDir) }),
      });
      if (!saved.ok) throw new Error(`config save failed: ${saved.status}`);
      window.dispatchEvent(new Event(APPS_CHANGED_EVENT));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {portInUse && (
        <PortInUseAlert
          name={apps?.find((a) => a.appId === portInUse.appId)?.manifest.name ?? portInUse.appId}
          port={portInUse.port}
          onChooseAnotherPort={() => void handleStart(portInUse.appId, true)}
        />
      )}

      {notice && (
        <Alert>
          <AlertTitle>Dependencies not installed</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      {apps === null && <p className="text-sm text-muted-foreground">Loading…</p>}
      {apps !== null && apps.length === 0 && (
        <p className="text-sm text-muted-foreground">No local apps found.</p>
      )}

      <AppCardGrid>
        {leading}
        {apps?.map((entry) => {
          const name = entry.manifest.name ?? entry.appId;
          const installed = entry.status === "active";
          // The registry could not be read. Every action below — installing,
          // uninstalling, reading the step ledger — needs a real answer, so the
          // card reports the gap and offers nothing until the server is up.
          const statusUnknown = entry.status === "unknown";
          const status = runStatus[entry.appId];
          const want = pending[entry.appId];
          const running = status?.running === true;
          const port = status?.port;
          const busy = !!want;
          const installBusy = busyAppId === entry.appId;
          const updating = update.updatingAppId === entry.appId;
          const sourceMissing = installed && entry.sourceState === "missing";
          const sourceChanged = installed && entry.sourceState === "changed";
          // The approved manifest still drives the app, so this is a note,
          // not a warning. It replaces the description, which comes from the
          // approved manifest too.
          const sourceInvalid = installed && entry.sourceState === "invalid";

          // One primary button per state: install what is not installed, start
          // what is stopped, open what is running. Everything else — stopping,
          // uninstalling, reading the install ledger — sits in the menu.
          const actions: AppCardAction[] = [];
          if (installed && running) {
            actions.push({
              label: want === "stop" ? "Stopping…" : "Stop",
              onSelect: () => handleStop(entry.appId),
              disabled: busy,
            });
          }
          if (installed) {
            actions.push({
              label: "Install steps…",
              onSelect: () => setStepsOpenFor(entry.appId),
            });
            actions.push({
              label: installBusy ? "Uninstalling…" : "Uninstall",
              onSelect: () => handleUninstall(entry),
              disabled: installBusy || running || busy,
              destructive: true,
              title: running ? "Stop the app before uninstalling" : undefined,
            });
          }
          // Only a registry answer of "not installed" offers Hide. An unknown
          // status may hide an installed app.
          if (entry.bundledExample && entry.status === "not_installed") {
            actions.push({ label: "Hide", onSelect: () => handleHide(entry) });
          }

          return (
            <AppCard
              key={entry.appId}
              name={name}
              version={entry.manifest.version ?? "?"}
              description={
                sourceInvalid ? (
                  <>
                    <b>Note:</b> The app&rsquo;s folder holds an invalid manifest (
                    {entry.sourceError}). Starkeep keeps using the manifest you approved at install.
                  </>
                ) : (
                  entry.manifest.description
                )
              }
              actions={actions}
              children={
                sourceMissing ? (
                  <p className="text-xs break-all text-destructive">
                    Source folder not found: <code>{entry.sourceDir}</code>. Restore the folder to
                    start the app. Uninstalling deletes its data on this machine.
                  </p>
                ) : sourceChanged ? (
                  <p className="text-xs text-muted-foreground">
                    Its folder holds a changed manifest.{" "}
                    {running ? "Stop and start the app to apply it." : "Start the app to apply it."}
                  </p>
                ) : undefined
              }
              badges={
                <>
                  {installed && (
                    <Badge
                      variant="secondary"
                      className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                    >
                      Installed
                    </Badge>
                  )}
                  {installed && running && port && (
                    <Badge
                      variant="secondary"
                      className="text-xs bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
                    >
                      Running :{port}
                    </Badge>
                  )}
                  {installed && !running && want === "start" && (
                    <Badge
                      variant="secondary"
                      className="text-xs bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
                    >
                      Starting…
                    </Badge>
                  )}
                  {installed && running && want === "stop" && (
                    <Badge
                      variant="secondary"
                      className="text-xs bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
                    >
                      Stopping…
                    </Badge>
                  )}
                  {statusUnknown && (
                    <Badge
                      variant="outline"
                      className="text-xs"
                      title="The local data server is offline, so its install registry could not be read."
                    >
                      Status unknown
                    </Badge>
                  )}
                  {!installed && !statusUnknown && (
                    <Badge variant="outline" className="text-xs">
                      Not installed
                    </Badge>
                  )}
                </>
              }
              primary={
                statusUnknown ? (
                  // No Install button here: offering one would repeat the
                  // claim that the app is not installed, which is exactly what
                  // we cannot know while the server is down.
                  <p className="text-sm text-muted-foreground">
                    Start the local data server to see this app&rsquo;s status.
                  </p>
                ) : !installed ? (
                  <span
                    className="block"
                    title={
                      localOnline ? undefined : "Start the local data server before installing"
                    }
                  >
                    <Button
                      size="sm"
                      className={ACTION_OCCASIONAL}
                      onClick={() => setPendingConsent(entry)}
                      disabled={installBusy || !localOnline}
                    >
                      {installBusy ? `Installing ${name}…` : `Install ${name}`}
                    </Button>
                  </span>
                ) : running ? (
                  // A running app without a reported port has no address to
                  // open, so the button stays in place and explains itself
                  // rather than disappearing.
                  port ? (
                    <Button asChild size="sm" className={ACTION_OPEN}>
                      <a
                        href={`http://localhost:${port}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open {name} ↗
                      </a>
                    </Button>
                  ) : (
                    // The title sits on the wrapper because a disabled button
                    // swallows the hover that would raise the tooltip.
                    <span className="block" title="No port found. Stop and restart to fix">
                      <Button size="sm" className={ACTION_OPEN} disabled>
                        Open {name} ↗
                      </Button>
                    </span>
                  )
                ) : (
                  <Button
                    size="sm"
                    className={ACTION_START}
                    // A changed folder manifest, here or in the cloud, opens
                    // the update dialog, which starts the app after it.
                    onClick={() => {
                      if (!update.requestUpdate(entry, "start")) void handleStart(entry.appId);
                    }}
                    disabled={busy || sourceMissing || updating || installBusy}
                  >
                    {(want === "start" || updating) && (
                      <span className="mr-1 size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    )}
                    {updating
                      ? `Updating ${name}…`
                      : want === "start"
                        ? `Starting ${name}…`
                        : `Start ${name}`}
                  </Button>
                )
              }
            />
          );
        })}
      </AppCardGrid>

      {pendingConsent && (
        <ConsentDialog
          entry={pendingConsent}
          onApprove={() => void handleApprove(pendingConsent)}
          onCancel={() => setPendingConsent(null)}
        />
      )}

      <Dialog
        open={depsRun !== null}
        onOpenChange={(open) => {
          if (!open && depsRun?.status !== "running") setDepsRun(null);
        }}
      >
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Installing {depsRun?.name}&rsquo;s dependencies</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            <code className="text-xs">{depsRun?.display}</code>
          </p>
          <CommandOutput lines={depsRun?.lines ?? []} status={depsRun?.status ?? "idle"} />
        </DialogContent>
      </Dialog>

      <InstallStepsDialog
        appId={stepsOpenFor}
        failure={installFailure?.appId === stepsOpenFor ? installFailure : null}
        onClose={() => {
          setStepsOpenFor(null);
          setInstallFailure(null);
        }}
      />
    </div>
  );
}

/**
 * Start found the app's recorded port held. The usual cause is the app itself,
 * already running there, so the alert links the address first. Moving the app
 * empties its browser storage, so the alert says so below the button.
 */
function PortInUseAlert({
  name,
  port,
  onChooseAnotherPort,
}: {
  name: string;
  port: number;
  onChooseAnotherPort: () => void;
}) {
  const url = `http://localhost:${port}`;
  return (
    <Alert variant="destructive">
      <AlertTitle>{name} cannot start</AlertTitle>
      <AlertDescription>
        <p>
          Its port {port} is in use. Is {name} already running at{" "}
          <a href={url} target="_blank" rel="noopener noreferrer" className="underline">
            {url}
          </a>
          ?
        </p>
        <Button variant="link" size="sm" className="h-auto p-0" onClick={onChooseAnotherPort}>
          Choose another port
        </Button>
        <p>On another port, {name} starts with empty browser storage.</p>
      </AlertDescription>
    </Alert>
  );
}

// ---------------------------------------------------------------------------
// Install-step ledger dialog. Reads from /api/apps/[appId]/install-status,
// which proxies the local-data-server's step ledger. Opens on demand (Steps
// button) and automatically when an install fails, with the failure on top,
// so the operator can see why and at which step the installer stopped.
// ---------------------------------------------------------------------------

/** An install failure as `/api/apps/install` reports it. */
type InstallFailure = { appId: string; error: string; details?: string[] };

function InstallStepsDialog({
  appId,
  failure,
  onClose,
}: {
  appId: string | null;
  failure: InstallFailure | null;
  onClose: () => void;
}) {
  const [steps, setSteps] = useState<InstallStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    setSteps(null);
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(id)}/install-status`);
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `install-status failed: ${res.status}`);
      }
      const body = (await res.json()) as { appId: string; steps: InstallStep[] };
      setSteps(body.steps);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (appId) load(appId);
  }, [appId, load]);

  const opened = appId !== null;

  return (
    <Dialog
      open={opened}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {failure ? `Install of ${appId} failed` : `Install steps for ${appId ?? "app"}`}
          </DialogTitle>
        </DialogHeader>

        {failure && (
          <Alert variant="destructive">
            <AlertTitle>{failure.error}</AlertTitle>
            {failure.details && failure.details.length > 0 && (
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {failure.details.map((d) => (
                    <li key={d} className="font-mono text-xs break-words">
                      {d}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            )}
          </Alert>
        )}

        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

        {error && (
          <Alert variant="destructive">
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!loading && !error && steps !== null && steps.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {failure
              ? "The install stopped before the installer recorded its first step."
              : "No install or uninstall steps recorded for this app."}
          </p>
        )}

        {!loading && !error && steps !== null && steps.length > 0 && (
          <div className="flex flex-col gap-2 max-h-96 overflow-y-auto">
            {steps.map((s, i) => (
              <div
                key={`${s.operation}-${s.step}-${i}`}
                className="flex flex-col gap-1 border rounded-md p-2 text-sm"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="secondary" className="text-xs">
                    {s.operation}
                  </Badge>
                  <span className="font-mono text-xs">{s.step}</span>
                  <Badge
                    variant="secondary"
                    className={
                      "text-xs " +
                      (s.status === "done"
                        ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                        : s.status === "failed"
                          ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
                          : "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200")
                    }
                  >
                    {s.status}
                  </Badge>
                  <span className="text-xs text-muted-foreground ml-auto">{s.updatedAt}</span>
                </div>
                {s.error && (
                  <pre className="text-xs whitespace-pre-wrap break-words text-red-700 dark:text-red-300">
                    {s.error}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-between gap-2 pt-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (appId) load(appId);
            }}
            disabled={!appId || loading}
          >
            Refresh
          </Button>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
