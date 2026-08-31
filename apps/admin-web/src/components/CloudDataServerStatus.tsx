"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppCard, type AppCardAction } from "@/components/AppCard";
import { ACTION_OCCASIONAL, ACTION_OPEN } from "@/lib/action-colors";
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
  /** When provided, the card offers Sign in / Sign out. */
  onSignIn?: () => void;
  onSignOut?: () => void;
  /** Takes the card's primary slot when given (e.g. the wizard's Redeploy). */
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

  // A caller-supplied action outranks the rest of the primary slot, so Sign in
  // falls back to the menu rather than disappearing.
  const primary = children ?? (
    !configured ? undefined : signedIn ? viewCostsButton : signInButton
  );

  const actions: AppCardAction[] = [];
  if (configured && !signedIn && children && onSignIn) {
    actions.push({ label: "Sign in", onSelect: onSignIn });
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
