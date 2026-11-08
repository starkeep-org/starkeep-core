import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppCard, type AppCardAction } from "@/components/AppCard";
import { ACTION_OCCASIONAL, ACTION_OPEN } from "@/lib/action-colors";
import { StatusBadge } from "./StatusBadge";
import type { CloudConfig, CognitoSession } from "../lib/cloud-config";
import { operatorSession } from "../lib/operator-session";

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
    return () => {
      cancelled = true;
    };
  }, [cloudConfig, refreshKey]);

  return state;
}

interface BuildRecord {
  bundleSha256: string;
  commit: string | null;
  dirty: boolean;
}

type BuildCheck =
  | { status: "idle" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      comparison: "not-recorded" | "no-local-build" | "local-build-stale" | "match" | "differs";
      cloud: BuildRecord | null;
    };

/**
 * Compares the cloud's build of the data server with this checkout's, through
 * POST /api/cloud-data-server/build. The record sits behind Manager, so the
 * check needs the operator's session and stays idle without one.
 */
function useCloudBuildCheck(enabled: boolean, refreshKey: number): BuildCheck {
  const [state, setState] = useState<BuildCheck>({ status: "idle" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "idle" });
    if (!enabled) return;

    (async () => {
      try {
        const session = await operatorSession();
        const res = await fetch("/api/cloud-data-server/build", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            credentials: session.credentials,
            stackPrefix: session.stackPrefix,
            region: session.region,
          }),
        });
        const body = (await res.json()) as {
          comparison?: Extract<BuildCheck, { status: "ready" }>["comparison"];
          cloud?: BuildRecord | null;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || !body.comparison) {
          setState({ status: "error", message: body.error ?? `Request failed (${res.status})` });
          return;
        }
        setState({ status: "ready", comparison: body.comparison, cloud: body.cloud ?? null });
      } catch (err) {
        if (!cancelled) {
          setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, refreshKey]);

  return state;
}

function buildName(build: BuildRecord): string {
  const commit = build.commit ? build.commit.slice(0, 7) : "an unknown commit";
  return build.dirty ? `${commit} with uncommitted changes` : commit;
}

const BUILD_COMMAND = "pnpm --filter @starkeep/builtin-cloud-data-server build";

/** One line about the cloud's build, or null when there is nothing to say. */
function BuildLine({ check, signedIn }: { check: BuildCheck; signedIn: boolean }) {
  const muted = "block text-muted-foreground";
  const warn = "block text-amber-700 dark:text-amber-300";
  if (!signedIn) {
    return (
      <span className={muted}>
        Sign in to compare the cloud&apos;s build with this checkout&apos;s.
      </span>
    );
  }
  if (check.status === "idle") return null;
  if (check.status === "error") {
    return <span className={muted}>Could not compare builds: {check.message}</span>;
  }
  const { comparison, cloud } = check;
  if (comparison === "not-recorded" || !cloud) {
    return (
      <span className={warn}>
        The cloud records no build, because its last deploy predates the record. Redeploy from
        Manage deployment in this card&apos;s menu to record one.
      </span>
    );
  }
  const running = `The cloud runs the build from ${buildName(cloud)}.`;
  if (comparison === "match") {
    return <span className={muted}>{running} This checkout builds the same code.</span>;
  }
  if (comparison === "differs") {
    return (
      <span className={warn}>
        {running} This checkout builds different code. Redeploy from Manage deployment in this
        card&apos;s menu to run it.
      </span>
    );
  }
  return (
    <span className={warn}>
      {running}{" "}
      {comparison === "no-local-build"
        ? "This checkout has no build to compare."
        : "This checkout's last build is older than the checkout."}{" "}
      Run <code>{BUILD_COMMAND}</code> to compare.
    </span>
  );
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
  /** When provided, the card offers "Sign in as admin" / "Sign out of admin". */
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
  const buildCheck = useCloudBuildCheck(configured && signedIn, refreshKey);

  const signInButton = onSignIn && (
    <Button size="sm" className={ACTION_OPEN} onClick={onSignIn}>
      Sign in as admin
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
    actions.push({ label: "Sign out of admin", onSelect: onSignOut, destructive: true });
  }

  return (
    <AppCard
      name="Data Server"
      badges={
        <>
          <Badge variant="secondary" className="text-xs">
            Built-in
          </Badge>
          {configured ? (
            <>
              <StatusBadge online={online} />
              {/* The operator's admin sign-in, held by this browser. The
                  machine's own sync sign-in is the This Machine section's, so
                  the badge names the admin to keep the two apart. */}
              {signedIn ? (
                <Badge
                  variant="secondary"
                  className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                >
                  Signed in as admin
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-xs">
                  Not signed in as admin
                </Badge>
              )}
            </>
          ) : (
            <Badge variant="secondary" className="text-xs">
              Not configured
            </Badge>
          )}
        </>
      }
      description={
        !configured ? (
          "Set up cloud to sync this machine's data beyond it."
        ) : (
          <>
            {state.status === "offline" ? (
              <span className="block">Could not reach the cloud data server: {state.reason}</span>
            ) : (
              signedIn && <span className="block">{cognitoSession?.userEmail}</span>
            )}
            <BuildLine check={buildCheck} signedIn={signedIn} />
          </>
        )
      }
      primary={primary}
      actions={actions}
    />
  );
}
