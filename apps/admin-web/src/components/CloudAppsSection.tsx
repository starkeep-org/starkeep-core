"use client";

import { useCallback, useEffect, useState } from "react";
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
import type { LocalAppEntry } from "@/lib/app-types";

export function CloudAppsSection({ apps }: { apps: LocalAppEntry[] | null }) {
  const [apiGatewayUrl, setApiGatewayUrl] = useState<string | null>(null);
  // null = config not yet read; false = no usable cloud setup (missing config
  // or region), which gates installs. The cloud Data Server card above surfaces
  // the "Set up cloud" CTA, so this section only disables installs.
  const [cloudReady, setCloudReady] = useState<boolean | null>(null);
  const [credError, setCredError] = useState<string | null>(null);
  // The app whose install modal is currently open (null when closed).
  const [installing, setInstalling] = useState<{ appId: string; appName: string; endpoint: string } | null>(null);
  const [credentials, setCredentials] = useState<(STSCredentials & { region?: string }) | null>(null);
  // Apps that the cloud registry reports as installed. Loaded from
  // `shared.app_registry` via POST /api/apps/cloud/list; refreshed after
  // every successful install. null = not yet loaded / cloud not configured.
  const [installedIds, setInstalledIds] = useState<Set<string> | null>(null);

  // Resolve the API Gateway base URL from the persisted cloud config so each
  // app's Open ↗ link (`${apiGatewayUrl}/apps/${appId}/`) survives a reload.
  // Once cloud is set up, showing the link is harmless even before install.
  useEffect(() => {
    (async () => {
      const cfg = await readCloudConfig();
      setApiGatewayUrl(cfg?.apiGatewayUrl ?? null);
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
      const body = (await res.json()) as { apps: Array<{ appId: string }> };
      setInstalledIds(new Set(body.apps.map((a) => a.appId)));
    } catch (err) {
      // The registry read is best-effort: a failure just means no "Installed"
      // badges. Don't surface it as a section-level error.
      console.warn("cloud registry list failed:", err);
    }
  }, []);

  useEffect(() => {
    refreshRegistry();
  }, [refreshRegistry]);

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

      {apps?.map((entry) => {
        const name = entry.manifest.name ?? entry.appId;
        // Cloud install is generic: any app discovered with a "cloud" target is
        // installable via the per-appId route, which drives the app's own
        // `bundle` script. No hardcoded installer registry.
        const endpoint = `/api/apps/${entry.appId}/cloud-install`;
        const url = apiGatewayUrl ? `${apiGatewayUrl}/apps/${entry.appId}/` : null;
        // `installedIds === null` means the registry hasn't been read yet
        // (user not signed in, cloud not set up, or the read errored). In
        // that case render no "Installed" badge rather than guessing.
        const installed = installedIds !== null && installedIds.has(entry.appId);
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
                <Button
                  size="sm"
                  onClick={() => handleInstall(entry.appId, name, endpoint)}
                  disabled={!cloudReady}
                  title={cloudReady ? undefined : "Set up cloud before installing apps"}
                >
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
        onSuccess={() => { refreshRegistry(); }}
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
