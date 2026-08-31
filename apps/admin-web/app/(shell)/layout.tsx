"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { AppDiscovery } from "../../src/components/AppDiscovery";
import {
  readCloudConfig,
  readCognitoSession,
  writeCloudCredentials,
} from "../../src/lib/cloud-config";
import { startCredentialRefreshTimer } from "../../src/lib/cognito-auth";

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
        <Link href="/" className="flex items-center gap-2">
          <span className="font-semibold">Starkeep Admin</span>
          <Badge variant="secondary" className="text-xs">Web</Badge>
        </Link>
        <AppDiscovery />
      </header>

      {/* The ground is a shade off the card color, so cards read as cards. */}
      <main className="flex-1 overflow-y-auto bg-surface p-6">
        {children}
      </main>
    </div>
  );
}

export default function ShellLayout({ children }: { children: ReactNode }) {
  return <ShellGate>{children}</ShellGate>;
}
