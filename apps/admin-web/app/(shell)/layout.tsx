"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  AppShell,
  NavLink,
  Group,
  Title,
  Badge,
  Loader,
  Center,
} from "@mantine/core";
import {
  readCloudConfig,
  writeCloudCredentials,
} from "../../src/lib/cloud-config";
import { startCredentialRefreshTimer } from "../../src/lib/cognito-auth";

function AppNavbar() {
  const pathname = usePathname();

  return (
    <div>
      <NavLink
        component={Link}
        href="/"
        label="Dashboard"
        active={pathname === "/"}
      />
      <NavLink
        component={Link}
        href="/settings"
        label="Settings"
        active={pathname === "/settings"}
      />
    </div>
  );
}

function ShellGate({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cleanupTimer: (() => void) | undefined;

    async function init() {
      const config = await readCloudConfig();
      if (config?.cognitoRefreshToken && config.cognitoConfig) {
        cleanupTimer = startCredentialRefreshTimer(
          config.cognitoConfig,
          () => config.cognitoRefreshToken,
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
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }

  return (
    <AppShell navbar={{ width: 220, breakpoint: "sm" }} header={{ height: 56 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="xs">
            <Title order={4}>Starkeep Admin</Title>
            <Badge variant="light" size="sm">
              Web
            </Badge>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        <AppNavbar />
      </AppShell.Navbar>

      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );
}

export default function ShellLayout({ children }: { children: ReactNode }) {
  return <ShellGate>{children}</ShellGate>;
}
