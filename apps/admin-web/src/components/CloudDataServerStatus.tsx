"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "./StatusBadge";
import type { CloudConfig, CognitoSession } from "../lib/cloud-config";

type OnlineState =
  | { status: "checking" }
  | { status: "no-config" }
  | { status: "online" }
  | { status: "offline"; reason: string };

interface Props {
  cloudConfig: CloudConfig | null;
  cognitoSession: CognitoSession | null;
  /** Bump to retrigger the online check. */
  refreshKey?: number;
  /** When provided, the auth row renders a Sign in / Sign out button. */
  onSignIn?: () => void;
  onSignOut?: () => void;
  /** Extra action slot rendered at the bottom of the card (e.g., Redeploy). */
  children?: ReactNode;
}

export function CloudDataServerStatus({
  cloudConfig,
  cognitoSession,
  refreshKey = 0,
  onSignIn,
  onSignOut,
  children,
}: Props) {
  const [state, setState] = useState<OnlineState>({ status: "checking" });

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

  const online: boolean | null =
    state.status === "checking" ? null
    : state.status === "online" ? true
    : state.status === "no-config" ? null
    : false;

  const signedIn = !!cognitoSession?.refreshToken;

  return (
    <div className="rounded-lg border p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Data Server</h3>
        {cloudConfig?.apiGatewayUrl ? (
          <StatusBadge online={online} />
        ) : (
          <Badge variant="secondary" className="text-xs">Not configured</Badge>
        )}
      </div>

      {state.status === "offline" && (
        <p className="text-xs text-muted-foreground">Could not reach the cloud data server: {state.reason}</p>
      )}

      {state.status === "no-config" && (
        <p className="text-sm text-muted-foreground">Complete cloud setup to enable remote features.</p>
      )}

      {cloudConfig?.apiGatewayUrl && (
        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="flex items-center gap-2">
            {signedIn ? (
              <>
                <Badge
                  variant="secondary"
                  className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                >
                  Signed in
                </Badge>
                {cognitoSession?.userEmail && (
                  <span className="text-sm text-muted-foreground">{cognitoSession.userEmail}</span>
                )}
              </>
            ) : (
              <Badge variant="secondary" className="text-xs">Not signed in</Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {signedIn
              ? onSignOut && (
                  <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={onSignOut}>
                    Sign out
                  </Button>
                )
              : onSignIn && (
                  <Button size="sm" variant="outline" onClick={onSignIn}>
                    Sign in
                  </Button>
                )}
          </div>
        </div>
      )}

      {children && (
        <div className="flex flex-wrap gap-2 pt-1">{children}</div>
      )}
    </div>
  );
}
