/**
 * The app update flow that Start and Redeploy share, and the cloud install
 * state that both app sections read.
 *
 * An install is behind when it runs something other than what the app's
 * folder holds now. The local install runs the folder's code directly, so it
 * is behind only when its card reports a changed folder manifest. The cloud
 * install is behind when its recorded manifest differs from the folder's, or
 * when its web app deployed other code than the folder holds, as
 * `/api/apps/cloud/list` reports per row.
 *
 * Start on a local card and Redeploy on a cloud card open one update dialog
 * when either install is behind. The dialog offers a checkbox per behind
 * install. Redeploy also offers its own cloud install while only the local
 * install is behind, so a Redeploy always reaches the cloud. After approval, the cloud deploys first, the local install updates
 * second, and the app starts last. The cloud goes first so the local app
 * never writes to a table the cloud lacks: the cloud refuses such a row and
 * stops the computer's uploads until it catches up.
 *
 * The provider owns the cloud registry, the AWS credential exchange and the
 * cloud install panel. The local section registers its reinstall and start
 * handlers, which keep their own progress and failure dialogs.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CommandOutput } from "@/components/CommandOutput";
import { ConsentDialog } from "@/components/ConsentDialog";
import {
  readCloudConfig,
  readCognitoSession,
  writeCloudCredentials,
  writeCognitoSession,
} from "@/lib/cloud-config";
import { refreshTokens, getIdentityPoolCredentials, type STSCredentials } from "@/lib/cognito-auth";
import {
  consentDiffers,
  MANIFEST_NOT_APPROVED,
  surfacesOf,
  targetsOf,
  type AppSurface,
  type LocalAppEntry,
  type ManifestSummary,
} from "@/lib/app-types";
import { runInstallStream } from "@/lib/install-stream-client";

/** The warning the update dialog shows when an install stays behind. */
export const SKEW_WARNING = "Running different app versions might affect syncing behavior.";

/** One row of `shared.app_registry`, as POST /api/apps/cloud/list returns it. */
export interface CloudRegistryRow {
  appId: string;
  name: string | null;
  version: string;
  webApp: boolean;
  mobileApp: boolean;
  /** The manifest the last install deployed, or null when the row predates it. */
  manifest: ManifestSummary | null;
  /**
   * Whether the cloud runs a manifest other than the one the app's folder
   * holds now. Null when no folder holds a valid manifest for the app.
   */
  behind?: boolean | null;
  /**
   * Whether the cloud web app runs code other than the folder holds now,
   * committed or not. Null when Admin cannot tell.
   */
  codeBehind?: boolean | null;
}

/** What Admin knows of the cloud's install registry. */
export type CloudRegistry =
  /** This machine administers no cloud. */
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "error" }
  | { kind: "ready"; rows: CloudRegistryRow[] };

/** Where an app's cloud install stands against its folder. */
export type CloudUpdate =
  /** No cloud here, no cloud install of the app, or a current one. */
  | { kind: "none" }
  | { kind: "behind"; surfaces: AppSurface[]; deployed: ManifestSummary | null }
  /**
   * A current cloud install that the person chose Redeploy on. The dialog
   * offers it while the local install is behind.
   */
  | { kind: "redeploy"; surfaces: AppSurface[] }
  /** Admin cannot tell, for the reason given. */
  | { kind: "unknown"; reason: string };

export interface Behind {
  local: boolean;
  cloud: CloudUpdate;
  /** The manifest the app's folder holds now. */
  folder: ManifestSummary;
}

/** Which of `entry`'s installs run a manifest other than its folder's. */
export function behindOf(entry: LocalAppEntry, registry: CloudRegistry): Behind {
  const folder = entry.folderManifest ?? entry.manifest;
  const local = entry.status === "active" && entry.sourceState === "changed";
  return { local, cloud: cloudUpdateOf(entry, folder, registry), folder };
}

function cloudUpdateOf(
  entry: LocalAppEntry,
  folder: ManifestSummary,
  registry: CloudRegistry,
): CloudUpdate {
  if (registry.kind === "none") return { kind: "none" };
  // An app the folder keeps off the cloud has no cloud install to update. A
  // registry row from a time the manifest targeted the cloud still counts,
  // so only an unread registry takes this answer.
  if (registry.kind !== "ready" && !targetsOf({ ...entry, manifest: folder }).includes("cloud")) {
    return { kind: "none" };
  }
  switch (registry.kind) {
    case "loading":
      return { kind: "unknown", reason: "Admin is still reading the cloud's app registry." };
    case "signed-out":
      return { kind: "unknown", reason: "Sign in to the cloud to update it." };
    case "error":
      return { kind: "unknown", reason: "Admin could not read the cloud's app registry." };
  }
  const row = registry.rows.find((r) => r.appId === entry.appId);
  if (!row) return { kind: "none" };
  const manifestBehind = row.behind === true && (row.webApp || row.mobileApp);
  const codeBehind = row.codeBehind === true && row.webApp;
  if (!manifestBehind && !codeBehind) return { kind: "none" };
  // A changed manifest updates every installed surface. Changed code updates
  // only the web app, since a mobile registration deploys no code.
  const offered = surfacesOf({ ...entry, manifest: folder });
  const surfaces = offered.filter((s) =>
    s === "web" ? row.webApp : manifestBehind && row.mobileApp,
  );
  if (surfaces.length === 0) {
    return {
      kind: "unknown",
      reason: "The folder's manifest no longer offers what the cloud has installed.",
    };
  }
  return { kind: "behind", surfaces, deployed: row.manifest };
}

/** A cloud install the panel runs. */
export interface CloudInstallRequest {
  appId: string;
  appName: string;
  surfaces: AppSurface[];
  /** The panel's title. */
  title: string;
  /**
   * The manifest the person approved: the one the dialog showed, or the
   * card's manifest for a tile that asked nothing. The route deploys only
   * when the app's folder still holds it.
   */
  approvedManifest: ManifestSummary;
  /** Close the panel on success, for a run that has more steps after it. */
  closeOnSuccess?: boolean;
}

/**
 * How a cloud install ended. A failure the panel showed carries no error; a
 * failure before the panel opened carries the reason.
 */
export type CloudInstallResult = { ok: true } | { ok: false; error?: string };

/** What the local section lets the update flow do. */
export interface LocalHandlers {
  /** Install dependencies and reinstall from the folder. False on failure. */
  reinstall: (entry: LocalAppEntry) => Promise<boolean>;
  start: (appId: string) => Promise<void>;
  isRunning: (appId: string) => boolean;
}

interface AppUpdateValue {
  registry: CloudRegistry;
  refreshRegistry: () => Promise<void>;
  /** A cloud install is in progress. Every cloud install shares one run slot. */
  cloudRunning: boolean;
  installCloud: (request: CloudInstallRequest) => Promise<CloudInstallResult>;
  /** The app the update flow is working on, or null. */
  updatingAppId: string | null;
  registerLocal: (handlers: LocalHandlers | null) => void;
  /**
   * Open the update dialog when an install of `entry` is behind its folder.
   * False when none is, and the caller goes on as before.
   */
  requestUpdate: (entry: LocalAppEntry, origin: UpdateOrigin) => boolean;
}

/** Start on a local card, or Redeploy on the cloud tile of one surface. */
export type UpdateOrigin = "start" | { redeploy: AppSurface };

const AppUpdateContext = createContext<AppUpdateValue | null>(null);

export function useAppUpdate(): AppUpdateValue {
  const value = useContext(AppUpdateContext);
  if (!value) throw new Error("useAppUpdate needs an AppUpdateProvider");
  return value;
}

export function AppUpdateProvider({
  cloudAdministered,
  signedIn,
  refreshApps,
  children,
}: {
  /** This machine deployed the cloud and holds what administers it. */
  cloudAdministered: boolean;
  /** An admin is signed in to the cloud. A change re-reads the registry. */
  signedIn: boolean;
  /**
   * Re-read the app list. A cloud install that the route refuses, such as
   * for a folder that changed after the person approved its manifest, calls
   * it, so the cards show what the folder holds now.
   */
  refreshApps?: () => void;
  children: ReactNode;
}) {
  const [registry, setRegistry] = useState<CloudRegistry>(
    cloudAdministered ? { kind: "loading" } : { kind: "none" },
  );
  const [installing, setInstalling] = useState<
    (CloudInstallRequest & { credentials: STSCredentials & { region: string } }) | null
  >(null);
  const [cloudRunning, setCloudRunning] = useState(false);
  const installDone = useRef<((result: CloudInstallResult) => void) | null>(null);
  const local = useRef<LocalHandlers | null>(null);
  const [pending, setPending] = useState<{
    entry: LocalAppEntry;
    origin: UpdateOrigin;
    behind: Behind;
  } | null>(null);
  const [updatingAppId, setUpdatingAppId] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<{ name: string; error: string } | null>(null);

  // Requires signed-in Cognito credentials. A failed read leaves the cloud
  // tiles without "Installed" badges and the update dialog without a cloud
  // choice, so it is not a section-level error.
  const refreshRegistry = useCallback(async () => {
    if (!cloudAdministered) {
      setRegistry({ kind: "none" });
      return;
    }
    try {
      const cfg = await readCloudConfig();
      if (!cfg) {
        setRegistry({ kind: "none" });
        return;
      }
      const session = await readCognitoSession();
      if (!session?.refreshToken) {
        setRegistry({ kind: "signed-out" });
        return;
      }
      const tokens = await refreshTokens(cfg.cognitoConfig, session.refreshToken);
      const creds = await getIdentityPoolCredentials(cfg.cognitoConfig, tokens.idToken);
      await writeCognitoSession({ ...session, refreshToken: tokens.refreshToken });
      const res = await fetch("/api/apps/cloud/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `cloud registry list failed: ${res.status}`);
      }
      const body = (await res.json()) as { apps: CloudRegistryRow[] };
      setRegistry({ kind: "ready", rows: body.apps });
    } catch (err) {
      console.warn("cloud registry list failed:", err);
      setRegistry({ kind: "error" });
    }
  }, [cloudAdministered]);

  useEffect(() => {
    void refreshRegistry();
  }, [refreshRegistry, signedIn]);

  const installCloud = useCallback(
    async (request: CloudInstallRequest): Promise<CloudInstallResult> => {
      const cfg = await readCloudConfig();
      if (!cfg)
        return { ok: false, error: "Cloud is not configured. Complete the cloud setup first." };
      const session = await readCognitoSession();
      if (!session?.refreshToken) {
        return { ok: false, error: "Not signed in. Sign in from the dashboard first." };
      }
      let creds: STSCredentials;
      try {
        const tokens = await refreshTokens(cfg.cognitoConfig, session.refreshToken);
        creds = await getIdentityPoolCredentials(cfg.cognitoConfig, tokens.idToken);
        await writeCloudCredentials(creds);
        await writeCognitoSession({ ...session, refreshToken: tokens.refreshToken });
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Failed to get AWS credentials",
        };
      }
      return new Promise<CloudInstallResult>((resolve) => {
        installDone.current = resolve;
        setInstalling({ ...request, credentials: { ...creds, region: cfg.region ?? "" } });
      });
    },
    [],
  );

  const settleInstall = (result: CloudInstallResult) => {
    const done = installDone.current;
    installDone.current = null;
    done?.(result);
  };

  const registerLocal = useCallback((handlers: LocalHandlers | null) => {
    local.current = handlers;
  }, []);

  const requestUpdate = useCallback(
    (entry: LocalAppEntry, origin: UpdateOrigin): boolean => {
      let behind = behindOf(entry, registry);
      if (!behind.local && behind.cloud.kind !== "behind") return false;
      // Redeploy and Re-register always reach the surface the person chose.
      // A current cloud install becomes a redeploy of that surface. A behind
      // one gains the surface when a code-only change left it out, as a
      // mobile registration deploys no code.
      if (origin !== "start") {
        const chosen = origin.redeploy;
        if (behind.cloud.kind === "none") {
          behind = { ...behind, cloud: { kind: "redeploy", surfaces: [chosen] } };
        } else if (behind.cloud.kind === "behind" && !behind.cloud.surfaces.includes(chosen)) {
          const current = behind.cloud.surfaces;
          const surfaces = (["web", "mobile"] as const).filter(
            (s) => s === chosen || current.includes(s),
          );
          behind = { ...behind, cloud: { ...behind.cloud, surfaces } };
        }
      }
      setPending({ entry, origin, behind });
      return true;
    },
    [registry],
  );

  // Cloud first, then the local install, then the start. Any failure stops
  // the run where it is, so the local app never runs ahead of the cloud.
  const runUpdate = async (
    entry: LocalAppEntry,
    origin: UpdateOrigin,
    behind: Behind,
    choice: { local: boolean; cloud: boolean },
  ) => {
    const name = entry.manifest.name ?? entry.appId;
    setUpdatingAppId(entry.appId);
    try {
      if (choice.cloud && (behind.cloud.kind === "behind" || behind.cloud.kind === "redeploy")) {
        const result = await installCloud({
          appId: entry.appId,
          appName: name,
          surfaces: behind.cloud.surfaces,
          title:
            behind.cloud.kind === "behind" ? `Update ${name} in the cloud` : `Redeploy ${name}`,
          // The dialog showed the folder's manifest, so the cloud route may
          // deploy it while the local install is behind.
          approvedManifest: behind.folder,
          closeOnSuccess: true,
        });
        if (!result.ok) {
          if (result.error) setUpdateError({ name, error: result.error });
          return;
        }
      }
      const handlers = local.current;
      if (!handlers) return;
      const wasRunning = handlers.isRunning(entry.appId);
      if (choice.local && behind.local) {
        if (!(await handlers.reinstall(entry))) return;
      }
      if (origin === "start" || (choice.local && wasRunning)) await handlers.start(entry.appId);
    } finally {
      setUpdatingAppId(null);
    }
  };

  const value: AppUpdateValue = {
    registry,
    refreshRegistry,
    cloudRunning,
    installCloud,
    updatingAppId,
    registerLocal,
    requestUpdate,
  };

  return (
    <AppUpdateContext.Provider value={value}>
      {children}

      {pending && (
        <UpdateDialog
          entry={pending.entry}
          origin={pending.origin}
          behind={pending.behind}
          onApprove={(choice) => {
            const { entry, origin, behind } = pending;
            setPending(null);
            void runUpdate(entry, origin, behind, choice);
          }}
          onCancel={() => setPending(null)}
        />
      )}

      <Dialog
        open={updateError !== null}
        onOpenChange={(open) => {
          if (!open) setUpdateError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{updateError?.name} did not update</DialogTitle>
          </DialogHeader>
          <Alert variant="destructive">
            <AlertTitle>The cloud update could not start</AlertTitle>
            <AlertDescription>{updateError?.error}</AlertDescription>
          </Alert>
        </DialogContent>
      </Dialog>

      <CloudAppInstallModal
        request={installing}
        onRunningChange={setCloudRunning}
        onRefused={() => refreshApps?.()}
        onSuccess={() => {
          void refreshRegistry();
          if (installing?.closeOnSuccess) {
            setInstalling(null);
            settleInstall({ ok: true });
          }
        }}
        onClose={(succeeded) => {
          setInstalling(null);
          settleInstall(succeeded ? { ok: true } : { ok: false });
        }}
      />
    </AppUpdateContext.Provider>
  );
}

/**
 * The update dialog: a checkbox per behind install, the file access when the
 * update changes it, and a warning when an install stays behind.
 */
function UpdateDialog({
  entry,
  origin,
  behind,
  onApprove,
  onCancel,
}: {
  entry: LocalAppEntry;
  origin: UpdateOrigin;
  behind: Behind;
  onApprove: (choice: { local: boolean; cloud: boolean }) => void;
  onCancel: () => void;
}) {
  const name = entry.manifest.name ?? entry.appId;
  const cloudKind = behind.cloud.kind;
  // The cloud install the dialog can run: one behind the folder, or the
  // current one the person chose Redeploy on.
  const cloudOffered = cloudKind === "behind" || cloudKind === "redeploy";
  const [local, setLocal] = useState(behind.local);
  const [cloud, setCloud] = useState(cloudOffered);

  const cloudChecked = cloudOffered && cloud;
  // A current cloud install left alone stays current, so only a behind or
  // unknown one warns.
  const warn =
    (behind.local && !local) ||
    ((cloudKind === "behind" || cloudKind === "unknown") && !cloudChecked);
  const accessChanged =
    (behind.local && local && consentDiffers(entry.manifest, behind.folder)) ||
    (behind.cloud.kind === "behind" &&
      cloudChecked &&
      (behind.cloud.deployed === null || consentDiffers(behind.cloud.deployed, behind.folder)));
  const cloudSurfaces =
    behind.cloud.kind === "behind" || behind.cloud.kind === "redeploy" ? behind.cloud.surfaces : [];
  const surface: "local" | AppSurface =
    local && behind.local ? "local" : cloudSurfaces.includes("web") ? "web" : "mobile";
  const nothingChecked = !(behind.local && local) && !cloudChecked;

  return (
    <ConsentDialog
      entry={{ ...entry, manifest: behind.folder }}
      surface={surface}
      title={`Update ${name}?`}
      showAccess={accessChanged}
      approveLabel={
        origin === "start" ? (nothingChecked ? `Start ${name}` : "Update & Start") : "Update"
      }
      approveDisabled={origin !== "start" && nothingChecked}
      onApprove={() => onApprove({ local: behind.local && local, cloud: cloudChecked })}
      onCancel={onCancel}
    >
      <p className="text-sm text-muted-foreground">
        {name}&rsquo;s folder has changes to install. Choose the installs to update.
      </p>
      <div className="flex flex-col gap-2">
        {behind.local && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={local}
              onChange={(e) => setLocal(e.target.checked)}
            />
            Update {name} on this computer
          </label>
        )}
        {cloudKind !== "none" && (
          <div className="flex flex-col gap-0.5">
            <label
              className={`flex items-center gap-2 text-sm ${cloudOffered ? "" : "text-muted-foreground"}`}
            >
              <input
                type="checkbox"
                className="size-4"
                checked={cloudChecked}
                disabled={!cloudOffered}
                onChange={(e) => setCloud(e.target.checked)}
              />
              {cloudKind === "redeploy"
                ? cloudSurfaces.includes("web")
                  ? `Redeploy ${name} in the cloud`
                  : `Re-register ${name} Mobile`
                : `Update ${name} in the cloud`}
            </label>
            {behind.cloud.kind === "unknown" && (
              <p className="pl-6 text-xs text-muted-foreground">{behind.cloud.reason}</p>
            )}
          </div>
        )}
      </div>
      {warn && <p className="text-sm text-amber-700 dark:text-amber-300">{SKEW_WARNING}</p>}
      {cloudChecked && (
        <p className="text-sm text-muted-foreground">
          The cloud update runs first and takes a few minutes.
        </p>
      )}
    </ConsentDialog>
  );
}

/** The streaming output of one cloud install, with Retry after a failure. */
function CloudAppInstallModal({
  request,
  onClose,
  onSuccess,
  onRunningChange,
  onRefused,
}: {
  request: (CloudInstallRequest & { credentials: STSCredentials & { region: string } }) | null;
  /** `succeeded` is true when the run that the panel shows succeeded. */
  onClose: (succeeded: boolean) => void;
  onSuccess: () => void;
  onRunningChange: (running: boolean) => void;
  /** The route refused the request with a 409, before any deploy started. */
  onRefused: () => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "running" | "success" | "failure">("idle");
  // A folder that no longer holds the approved manifest refuses every retry
  // of the same request, so the panel offers no Retry for it.
  const [stale, setStale] = useState(false);
  // Bumped by the Retry button to re-drive the install effect. Most install
  // failures are transient (IAM/S3 eventual consistency) and clear on retry.
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    onRunningChange(status === "running");
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!request) return;
    const { appId, credentials, surfaces, approvedManifest } = request;

    setLines([]);
    setStatus("running");
    setStale(false);
    let aborted = false;

    async function run() {
      // The deploy runs detached on the server, so a dropped stream reconnects
      // to it rather than leaving the dialog spinning.
      const outcome = await runInstallStream(
        `/api/apps/${appId}/cloud-install`,
        {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          sessionToken: credentials.sessionToken,
          region: credentials.region,
          surfaces,
          approvedManifest,
        },
        { onLine: (line) => setLines((l) => [...l, line]), isAborted: () => aborted },
      );
      if (aborted) return;
      if (outcome.kind === "done") {
        setStatus("success");
        onSuccess();
      } else {
        setLines((l) => [...l, `Error: ${outcome.message}`]);
        setStatus("failure");
        // A 409 can say the cards' manifests are out of date, so the app
        // list is re-read. Another install running also answers 409, and a
        // retry once it ends is the way through.
        if (outcome.status === 409) onRefused();
        if (outcome.code === MANIFEST_NOT_APPROVED) setStale(true);
      }
    }

    void run();
    return () => {
      aborted = true;
    };
  }, [request, retryNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && status !== "running") onClose(status === "success");
      }}
    >
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{request?.title}</DialogTitle>
        </DialogHeader>
        <CommandOutput lines={lines} status={status} />
        {status !== "running" && (
          <div className="flex items-center justify-end gap-3">
            {status === "failure" && !stale && (
              <>
                <p className="mr-auto text-sm text-muted-foreground">
                  Most failures are transitory and fixed with a retry.
                </p>
                <Button onClick={() => setRetryNonce((n) => n + 1)}>Retry</Button>
              </>
            )}
            <Button variant="outline" onClick={() => onClose(status === "success")}>
              Close
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
