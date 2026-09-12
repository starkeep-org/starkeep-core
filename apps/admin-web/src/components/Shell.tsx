/**
 * The shell every page renders inside: the header, the app-discovery control,
 * and the gate that starts credential refresh before a page is painted.
 *
 * A layout route rather than a wrapper each page renders, which is what
 * `app/(shell)/layout.tsx` was. The distinction matters: the gate's effect runs
 * once for the session rather than once per navigation, so moving between the
 * dashboard and the wizard does not re-read the config or restart the refresh
 * timer.
 */

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link, Outlet } from "react-router";
import { Badge } from "@/components/ui/badge";
import { AppDiscovery } from "./AppDiscovery";
import { readCloudConfig, readCognitoSession, writeCloudCredentials } from "../lib/cloud-config";
import { startCredentialRefreshTimer } from "../lib/cognito-auth";

function ShellGate({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cleanupTimer: (() => void) | undefined;

    async function init() {
      const config = await readCloudConfig();
      const session = await readCognitoSession();
      if (config?.cognitoConfig && session?.refreshToken) {
        cleanupTimer = startCredentialRefreshTimer(
          config.cognitoConfig,
          async () => {
            const s = await readCognitoSession();
            return s?.refreshToken ?? null;
          },
          async (newCreds) => {
            await writeCloudCredentials(newCreds).catch(console.error);
          },
          (err) => console.warn("Credential refresh failed:", err),
        );
      }
      setLoading(false);
    }

    init();
    return () => cleanupTimer?.();
  }, []);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="size-5 animate-spin rounded-full border-2 border-border border-t-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex h-14 items-center justify-between border-b px-6 shrink-0">
        <Link to="/" className="flex items-center gap-2">
          <span className="font-semibold">Starkeep Admin</span>
          <Badge variant="secondary" className="text-xs">Web</Badge>
        </Link>
        <AppDiscovery />
      </header>

      {/* Each page brings its own ground and padding. The dashboard lays cards
          on the off-white surface so they read as cards; the detail pages carry
          prose and forms, which read as a document on the page background. */}
      <main className="flex-1 overflow-y-auto">
        {children}
      </main>
    </div>
  );
}

export function Shell() {
  return (
    <ShellGate>
      <Outlet />
    </ShellGate>
  );
}
