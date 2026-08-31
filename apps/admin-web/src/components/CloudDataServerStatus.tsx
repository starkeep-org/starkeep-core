"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppCard, type AppCardAction } from "@/components/AppCard";
import { ACTION_OCCASIONAL, ACTION_OPEN } from "@/lib/action-colors";
import { StatusBadge } from "./StatusBadge";
import type { CloudConfig, CognitoSession } from "../lib/cloud-config";

export type CloudHealth =
  | { status: "checking" }
  | { status: "no-config" }
  | { status: "online" }
  | { status: "offline"; reason: string };

/**
 * Polls the cloud data server's liveness route. The dashboard card and the
 * setup wizard's deploy step both report reachability, in two shapes that share
 * nothing but this probe.
 */
export function useCloudDataServerHealth(
  cloudConfig: CloudConfig | null,
  refreshKey = 0,
): CloudHealth {
  const [state, setState] = useState<CloudHealth>({ status: "checking" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "checking" });

    async function check() {
      if (!cloudConfig?.apiGatewayUrl) {
        if (!cancelled) setState({ status: "no-config" });
        return;
      }
      // `GET /health` is the cloud-data-server's public liveness route — no
      // JWT required and CORS=* on the API Gateway, so the browser can hit it
      // directly. Per-app data routes (`/apps/{appId}/data/*`) need an app
      // identity that admin-web doesn't have, so we don't try them here.
      try {
        const resp = await fetch(`${cloudConfig.apiGatewayUrl}/health`, {
          signal: AbortSignal.timeout(8000),
        });
        if (cancelled) return;
        if (resp.ok) {
          setState({ status: "online" });
        } else {
          setState({ status: "offline", reason: `${resp.status} ${resp.statusText}` });
        }
      } catch (err) {
        if (!cancelled) {
          setState({ status: "offline", reason: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    check();
    return () => { cancelled = true; };
  }, [cloudConfig, refreshKey]);

  return state;
}

/** Maps the probe onto the tri-state `StatusBadge` reads. */
export function healthToOnline(health: CloudHealth): boolean | null {
  return health.status === "checking" || health.status === "no-config"
    ? null
    : health.status === "online";
}

interface Props {
  cloudConfig: CloudConfig | null;
  cognitoSession: CognitoSession | null;
  /** Bump to retrigger the online check. */
  refreshKey?: number;
  /** When provided, the card offers Sign in / Sign out. */
  onSignIn?: () => void;
  onSignOut?: () => void;
}

export function CloudDataServerStatus({
  cloudConfig,
  cognitoSession,
  refreshKey = 0,
  onSignIn,
  onSignOut,
}: Props) {
  const state = useCloudDataServerHealth(cloudConfig, refreshKey);
  const online = healthToOnline(state);

  const configured = !!cloudConfig?.apiGatewayUrl;
  const signedIn = !!cognitoSession?.refreshToken;

  const signInButton = onSignIn && (
    <Button size="sm" className={ACTION_OPEN} onClick={onSignIn}>
      Sign in
    </Button>
  );

  // Costs need the signed-in session, so the jump only appears once signed in.
  // The target is the Costs section further down the dashboard, the only page
  // this card renders on.
  const viewCostsButton = (
    <Button asChild size="sm" className={ACTION_OCCASIONAL}>
      <a href="#costs">View Costs</a>
    </Button>
  );

  const primary = !configured ? undefined : signedIn ? viewCostsButton : signInButton;

  // The dashboard drops its "Manage deployment" button once the cloud is up,
  // because the wizard from then on acts on this deployment — so the way back
  // into it hangs off the card that reports the deployment's state.
  const actions: AppCardAction[] = [];
  if (configured) {
    actions.push({ label: "Manage deployment…", href: "/cloud-setup" });
  }
  if (configured && signedIn && onSignOut) {
    actions.push({ label: "Sign out", onSelect: onSignOut, destructive: true });
  }

  return (
    <AppCard
      name="Data Server"
      badges={
        <>
          <Badge variant="secondary" className="text-xs">Built-in</Badge>
          {configured ? (
            <>
              <StatusBadge online={online} />
              {signedIn ? (
                <Badge
                  variant="secondary"
                  className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                >
                  Signed in
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-xs">Not signed in</Badge>
              )}
            </>
          ) : (
            <Badge variant="secondary" className="text-xs">Not configured</Badge>
          )}
        </>
      }
      description={
        !configured ? (
          "Set up cloud to sync this machine's data beyond it."
        ) : state.status === "offline" ? (
          `Could not reach the cloud data server: ${state.reason}`
        ) : (
          <>
            <span className="block">Syncs data beyond this machine.</span>
            {signedIn && cognitoSession?.userEmail}
          </>
        )
      }
      primary={primary}
      actions={actions}
    />
  );
}
