import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ConsentDialog } from "@/components/ConsentDialog";
import { useAppUpdate, type CloudInstallRequest } from "@/components/AppUpdate";
import { readCloudConfig } from "@/lib/cloud-config";
import { AppCard, AppCardGrid, type AppCardAction } from "@/components/AppCard";
import { ACTION_OCCASIONAL, ACTION_OPEN } from "@/lib/action-colors";
import { consentDiffers, surfacesOf, type AppSurface, type LocalAppEntry } from "@/lib/app-types";

/** Why a tile from the registry alone cannot redeploy or re-register. */
function noFolder(surface: AppSurface): string {
  return `Add the app's folder in Discover apps to ${surface === "web" ? "redeploy" : "re-register"}`;
}

function InstalledBadge({ verb }: { verb: string }) {
  return (
    <Badge
      variant="secondary"
      className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
    >
      {verb}
    </Badge>
  );
}

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
  // The cloud registry, the install panel and its one run slot live in the
  // update flow, which the local cards share. See AppUpdate.tsx.
  const {
    registry,
    cloudRunning: running,
    installCloud,
    requestUpdate,
    updatingAppId,
  } = useAppUpdate();
  const registryRows = registry.kind === "ready" ? registry.rows : null;
  const webIds = registryRows && new Set(registryRows.filter((a) => a.webApp).map((a) => a.appId));
  const mobileIds =
    registryRows && new Set(registryRows.filter((a) => a.mobileApp).map((a) => a.appId));
  // The install waiting on the consent dialog, or null when none is open.
  const [pendingConsent, setPendingConsent] = useState<{
    entry: LocalAppEntry;
    surface: AppSurface;
    title: string;
    run: () => void;
  } | null>(null);

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

  const handleInstall = async (request: CloudInstallRequest) => {
    setCredError(null);
    const result = await installCloud(request);
    if (!result.ok && result.error) setCredError(result.error);
  };

  const listedIds = new Set((apps ?? []).map((a) => a.appId));
  const unlisted = apps === null ? [] : (registryRows ?? []).filter((r) => !listedIds.has(r.appId));

  return (
    <div className="flex flex-col gap-3">
      {credError && (
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{credError}</AlertDescription>
        </Alert>
      )}

      {apps === null && <p className="text-sm text-muted-foreground">Loading…</p>}
      {apps !== null && apps.length === 0 && unlisted.length === 0 && (
        <p className="text-sm text-muted-foreground">No cloud apps found.</p>
      )}

      <AppCardGrid>
        {leading}
        {apps?.flatMap((entry) => {
          const name = entry.manifest.name ?? entry.appId;
          const url = browserBaseUrl ? `${browserBaseUrl}/apps/${entry.appId}/` : null;
          // One run at a time across every tile, and none before cloud is set up.
          // A locally installed app deploys only the manifest the user
          // approved, so a first cloud install waits until the local install
          // takes the folder's changed manifest. An installed tile's update
          // goes through the update dialog, which approves it.
          const changed =
            entry.sourceState === "changed"
              ? "Its folder holds a changed manifest. Choose Start or Redeploy to update it."
              : undefined;
          const blocked = !cloudReady
            ? "Set up cloud before installing apps"
            : running
              ? "Another cloud install is running"
              : updatingAppId === entry.appId
                ? `${name} is updating`
                : entry.sourceState === "invalid"
                  ? "Its folder holds an invalid manifest. Fix the manifest first"
                  : entry.sourceState === "missing"
                    ? "Its source folder is not found"
                    : undefined;

          // One tile per surface the manifest offers. Each tile reads only its
          // own registry column and installs only its own surface.
          return surfacesOf(entry).map((surface) => {
            const tileName = surface === "web" ? name : `${name} Mobile`;
            // A null set means the registry hasn't been read yet (user not
            // signed in, cloud not set up, or the read errored). The tile
            // then reads as not installed rather than guessing.
            const installed = (surface === "web" ? webIds : mobileIds)?.has(entry.appId) ?? false;
            // Two records carry a past approval. A local install pins the
            // manifest the person approved, and the cloud deploys that pinned
            // manifest. A cloud install records the manifest it deployed in the
            // registry. Either one covers this install unless the folder's
            // manifest now asks for something the dialog would show that the
            // approved one did not. A first cloud install of an app never
            // installed locally has neither record, and asks.
            const deployed = registryRows?.find((r) => r.appId === entry.appId)?.manifest ?? null;
            const approved =
              entry.status === "active" ||
              (deployed !== null && !consentDiffers(deployed, entry.manifest));
            const run = () =>
              void handleInstall({
                appId: entry.appId,
                appName: name,
                surfaces: [surface],
                title: surface === "mobile" ? `Register ${tileName}` : `Install ${name} in cloud`,
              });
            const install = approved
              ? run
              : () =>
                  setPendingConsent({
                    entry,
                    surface,
                    title:
                      surface === "web" ? `Install ${name} in the cloud?` : `Register ${tileName}?`,
                    run,
                  });

            const actions: AppCardAction[] = installed
              ? [
                  {
                    label: surface === "web" ? `Redeploy ${name}` : `Re-register ${tileName}`,
                    // An install behind the folder updates through the
                    // update dialog, which redeploys every installed surface.
                    onSelect: () => {
                      if (!requestUpdate(entry, "redeploy")) install();
                    },
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
                <span className="block" title={blocked ?? changed}>
                  <Button
                    size="sm"
                    className={ACTION_OCCASIONAL}
                    onClick={install}
                    disabled={blocked !== undefined || changed !== undefined}
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
                    <InstalledBadge verb={verb} />
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
        {unlisted.flatMap((row) => {
          const name = row.name ?? row.appId;
          const url = browserBaseUrl ? `${browserBaseUrl}/apps/${row.appId}/` : null;
          const surfaces: AppSurface[] = [
            ...(row.webApp ? (["web"] as const) : []),
            ...(row.mobileApp ? (["mobile"] as const) : []),
          ];
          // Redeploy and Re-register build from the app's folder, which no
          // scanned folder holds.
          return surfaces.map((surface) => {
            const tileName = surface === "web" ? name : `${name} Mobile`;
            return (
              <AppCard
                key={`${row.appId}:${surface}`}
                name={tileName}
                version={row.version}
                description="Installed in the cloud. Its folder is not in Discover apps."
                actions={[
                  {
                    label: surface === "web" ? `Redeploy ${name}` : `Re-register ${tileName}`,
                    disabled: true,
                    title: noFolder(surface),
                  },
                ]}
                badges={<InstalledBadge verb={surface === "web" ? "Installed" : "Registered"} />}
                primary={
                  surface === "web" && url ? (
                    <Button asChild size="sm" className={ACTION_OPEN}>
                      <a href={url} target="_blank" rel="noopener noreferrer" title={url}>
                        Open {name} ↗
                      </a>
                    </Button>
                  ) : null
                }
              />
            );
          });
        })}
      </AppCardGrid>

      {pendingConsent && (
        <ConsentDialog
          entry={pendingConsent.entry}
          surface={pendingConsent.surface}
          title={pendingConsent.title}
          onApprove={() => {
            const { run } = pendingConsent;
            setPendingConsent(null);
            run();
          }}
          onCancel={() => setPendingConsent(null)}
        />
      )}
    </div>
  );
}
