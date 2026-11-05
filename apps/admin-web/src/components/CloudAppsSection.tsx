import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { CommandOutput } from "@/components/CommandOutput";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  readCloudConfig,
  readCognitoSession,
  writeCloudCredentials,
  writeCognitoSession,
} from "@/lib/cloud-config";
import { refreshTokens, getIdentityPoolCredentials, type STSCredentials } from "@/lib/cognito-auth";
import { AppCard, AppCardGrid, type AppCardAction } from "@/components/AppCard";
import { ACTION_OCCASIONAL, ACTION_OPEN } from "@/lib/action-colors";
import {
  publicSharingConsent,
  surfacesOf,
  type AppSurface,
  type LocalAppEntry,
} from "@/lib/app-types";
import { runInstallStream } from "@/lib/install-stream-client";

export function CloudAppsSection({
  apps,
  leading,
}: {
  apps: LocalAppEntry[] | null;
  /** Cards rendered ahead of the discovered apps — the built-in Data Server. */
  leading?: ReactNode;
}) {
  const [browserBaseUrl, setBrowserBaseUrl] = useState<string | null>(null);
  // null = config not yet read; false = no usable cloud setup (missing config
  // or region), which gates installs. The cloud Data Server card above surfaces
  // the "Set up cloud" CTA, so this section only disables installs.
  const [cloudReady, setCloudReady] = useState<boolean | null>(null);
  const [credError, setCredError] = useState<string | null>(null);
  // The tile whose install modal is currently open (null when closed). Each
  // tile installs its own surface on top of the app's data side, and no other.
  const [installing, setInstalling] = useState<{
    appId: string;
    appName: string;
    endpoint: string;
    surface: AppSurface;
  } | null>(null);
  // Whether the open modal's run is in progress. Every cloud app install
  // shares one run slot on the server, so every tile waits for it.
  const [running, setRunning] = useState(false);
  const [credentials, setCredentials] = useState<(STSCredentials & { region?: string }) | null>(
    null,
  );
  // Apps whose cloud web app, and apps whose mobile app, the registry reports
  // as installed. Loaded from `shared.app_registry` via POST
  // /api/apps/cloud/list; refreshed after every successful install. null = not
  // yet loaded / cloud not configured. The two surfaces install independently,
  // each on top of the app's shared data side.
  const [webIds, setWebIds] = useState<Set<string> | null>(null);
  const [mobileIds, setMobileIds] = useState<Set<string> | null>(null);

  // Resolve the browser-facing base URL from the persisted cloud config so each
  // app's Open ↗ link (`${browserBaseUrl}/apps/${appId}/`) survives a reload.
  // Prefer the CloudFront distribution (publicBaseUrl) so the app loads
  // same-origin with the shared image bytes it fetches; fall back to the raw
  // gateway for pre-CloudFront configs. Once cloud is set up, showing the link
  // is harmless even before install.
  useEffect(() => {
    (async () => {
      const cfg = await readCloudConfig();
      setBrowserBaseUrl(cfg?.publicBaseUrl ?? cfg?.apiGatewayUrl ?? null);
      // A usable cloud setup needs config present with a derivable region
      // (region comes from the userPoolId). Without it, installs can't run.
      setCloudReady(!!cfg?.region);
    })();
  }, []);

  // Refresh the cloud install registry. Requires signed-in Cognito creds —
  // skips silently if the user hasn't signed in (registry stays null and the
  // section falls back to showing no "Installed" badge until they auth).
  const refreshRegistry = useCallback(async () => {
    try {
      const cfg = await readCloudConfig();
      if (!cfg) return; // cloud not configured
      const session = await readCognitoSession();
      if (!session?.refreshToken) return; // not signed in
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
      const body = (await res.json()) as {
        apps: Array<{ appId: string; webApp: boolean; mobileApp: boolean }>;
      };
      setWebIds(new Set(body.apps.filter((a) => a.webApp).map((a) => a.appId)));
      setMobileIds(new Set(body.apps.filter((a) => a.mobileApp).map((a) => a.appId)));
    } catch (err) {
      // The registry read is best-effort: a failure just means no "Installed"
      // badges. Don't surface it as a section-level error.
      console.warn("cloud registry list failed:", err);
    }
  }, []);

  useEffect(() => {
    refreshRegistry();
  }, [refreshRegistry]);

  const handleInstall = async (
    appId: string,
    appName: string,
    endpoint: string,
    surface: AppSurface,
  ) => {
    setCredError(null);
    const cfg = await readCloudConfig();
    if (!cfg) {
      setCredError("Cloud is not configured. Complete the cloud setup first.");
      return;
    }

    const session = await readCognitoSession();
    if (!session?.refreshToken) {
      setCredError("Not signed in. Sign in from the dashboard first.");
      return;
    }

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
    setInstalling({ appId, appName, endpoint, surface });
  };

  return (
    <div className="flex flex-col gap-3">
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

      <AppCardGrid>
        {leading}
        {apps?.flatMap((entry) => {
          const name = entry.manifest.name ?? entry.appId;
          // Cloud install is generic: any app discovered with a "cloud" target is
          // installable via the per-appId route, which drives the app's own
          // `bundle` script. No hardcoded installer registry.
          const endpoint = `/api/apps/${entry.appId}/cloud-install`;
          const url = browserBaseUrl ? `${browserBaseUrl}/apps/${entry.appId}/` : null;
          // One run at a time across every tile, and none before cloud is set up.
          const blocked = !cloudReady
            ? "Set up cloud before installing apps"
            : running
              ? "Another cloud install is running"
              : undefined;

          // One tile per surface the manifest offers. Each tile reads only its
          // own registry column and installs only its own surface.
          return surfacesOf(entry).map((surface) => {
            const tileName = surface === "web" ? name : `${name} Mobile`;
            // A null set means the registry hasn't been read yet (user not
            // signed in, cloud not set up, or the read errored). The tile
            // then reads as not installed rather than guessing.
            const installed = (surface === "web" ? webIds : mobileIds)?.has(entry.appId) ?? false;
            // The cloud install has no consent dialog of its own, so the one
            // capability a person must approve before the cloud acts on it is
            // asked here: public links are served by the cloud web app.
            const consent =
              surface === "web" && !installed ? publicSharingConsent(entry.manifest) : null;
            const install = () => {
              if (consent && !confirm(`${consent}\n\nInstall ${name} in the cloud?`)) return;
              void handleInstall(entry.appId, name, endpoint, surface);
            };

            const actions: AppCardAction[] = installed
              ? [
                  {
                    label: surface === "web" ? `Redeploy ${name}` : `Re-register ${tileName}`,
                    onSelect: install,
                    disabled: blocked !== undefined,
                    title: blocked,
                  },
                ]
              : [];

            const verb = surface === "web" ? "Installed" : "Registered";

            let primary: ReactNode = null;
            if (!installed) {
              primary = (
                // The title sits on the wrapper because a disabled button
                // swallows the hover that would raise the tooltip.
                <span className="block" title={blocked}>
                  <Button
                    size="sm"
                    className={ACTION_OCCASIONAL}
                    onClick={install}
                    disabled={blocked !== undefined}
                  >
                    {surface === "web" ? `Install ${name} in cloud` : `Register ${tileName}`}
                  </Button>
                </span>
              );
            } else if (surface === "web" && url) {
              primary = (
                <Button asChild size="sm" className={ACTION_OPEN}>
                  <a href={url} target="_blank" rel="noopener noreferrer" title={url}>
                    Open {name} ↗
                  </a>
                </Button>
              );
            }

            return (
              <AppCard
                key={`${entry.appId}:${surface}`}
                name={tileName}
                version={entry.manifest.version ?? "?"}
                description={
                  surface === "web"
                    ? entry.manifest.description
                    : `The ${name} mobile app can sign in and sync with this cloud.`
                }
                actions={actions}
                badges={
                  installed ? (
                    <Badge
                      variant="secondary"
                      className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                    >
                      {verb}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs">
                      Not {verb.toLowerCase()}
                    </Badge>
                  )
                }
                primary={primary}
              />
            );
          });
        })}
      </AppCardGrid>

      <CloudAppInstallModal
        opened={installing !== null}
        appId={installing?.appId ?? null}
        appName={installing?.appName ?? null}
        endpoint={installing?.endpoint ?? null}
        surface={installing?.surface ?? null}
        credentials={credentials}
        onRunningChange={setRunning}
        onClose={() => {
          setInstalling(null);
          setCredentials(null);
        }}
        onSuccess={() => {
          refreshRegistry();
        }}
      />
    </div>
  );
}

function CloudAppInstallModal({
  opened,
  appName,
  endpoint,
  surface,
  credentials,
  onClose,
  onSuccess,
  onRunningChange,
}: {
  opened: boolean;
  appId: string | null;
  appName: string | null;
  endpoint: string | null;
  surface: AppSurface | null;
  credentials: STSCredentials | null;
  onClose: () => void;
  onSuccess?: () => void;
  onRunningChange?: (running: boolean) => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "running" | "success" | "failure">("idle");
  // Bumped by the Retry button to re-drive the install effect. Most install
  // failures are transient (IAM/S3 eventual consistency) and clear on retry.
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    onRunningChange?.(status === "running");
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!opened || !credentials || !endpoint || !surface) return;

    setLines([]);
    setStatus("running");
    let aborted = false;

    async function run() {
      // The deploy runs detached on the server, so a dropped stream reconnects
      // to it rather than leaving the dialog spinning.
      const outcome = await runInstallStream(
        endpoint!,
        {
          accessKeyId: credentials!.accessKeyId,
          secretAccessKey: credentials!.secretAccessKey,
          sessionToken: credentials!.sessionToken,
          region: (credentials as STSCredentials & { region?: string }).region ?? "",
          surfaces: [surface!],
        },
        { onLine: (line) => setLines((l) => [...l, line]), isAborted: () => aborted },
      );
      if (aborted) return;
      if (outcome.kind === "done") {
        setStatus("success");
        onSuccess?.();
      } else {
        setLines((l) => [...l, `Error: ${outcome.message}`]);
        setStatus("failure");
      }
    }

    run();
    return () => {
      aborted = true;
    };
  }, [opened, credentials, endpoint, surface, retryNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dialog
      open={opened}
      onOpenChange={(open) => {
        if (!open && status !== "running") onClose();
      }}
    >
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {surface === "mobile"
              ? `Register ${appName ?? "app"} Mobile`
              : `Install ${appName ?? "app"} in cloud`}
          </DialogTitle>
        </DialogHeader>
        <CommandOutput lines={lines} status={status} />
        {status !== "running" && (
          <div className="flex items-center justify-end gap-3">
            {status === "failure" && (
              <>
                <p className="mr-auto text-sm text-muted-foreground">
                  Most failures are transitory and fixed with a retry.
                </p>
                <Button onClick={() => setRetryNonce((n) => n + 1)}>Retry</Button>
              </>
            )}
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
