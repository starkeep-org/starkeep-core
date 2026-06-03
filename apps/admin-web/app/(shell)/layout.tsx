"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  readCloudConfig,
  readCognitoSession,
  writeCloudCredentials,
} from "../../src/lib/cloud-config";
import { startCredentialRefreshTimer } from "../../src/lib/cognito-auth";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard" },
  { href: "/apps", label: "Apps" },
  { href: "/settings", label: "Cloud Setup" },
];

function AppNavbar() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1 p-3">
      {NAV_ITEMS.map(({ href, label }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

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
      <header className="flex h-14 items-center border-b px-4 shrink-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold">Starkeep Admin</span>
          <Badge variant="secondary" className="text-xs">Web</Badge>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-52 shrink-0 border-r overflow-y-auto">
          <AppNavbar />
        </aside>

        <Separator orientation="vertical" className="h-full" />

        {/* Main content */}
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>
    </div>
  );
}

export default function ShellLayout({ children }: { children: ReactNode }) {
  return <ShellGate>{children}</ShellGate>;
}
