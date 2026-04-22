"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import {
  AppShell,
  NavLink,
  Group,
  Title,
  Badge,
  Loader,
  Center,
  SegmentedControl,
  Stack,
} from "@mantine/core";
import { DataSourceProvider, DataSourceContext } from "../../src/lib/data-source-context";
import { useContext } from "react";
import type { DataSourceMode } from "../../src/lib/data-client";
import {
  getCloudSetupState,
  readCloudConfig,
  writeCloudCredentials,
} from "../../src/lib/cloud-config";
import { startCredentialRefreshTimer } from "../../src/lib/cognito-auth";

function AppNavbar() {
  const pathname = usePathname();
  const { mode, setMode, remoteAvailable } = useContext(DataSourceContext);

  return (
    <Stack h="100%" justify="space-between">
      <div>
        <NavLink
          component={Link}
          href="/"
          label="Dashboard"
          active={pathname === "/"}
        />
        <NavLink
          component={Link}
          href="/deployments"
          label="Deployments"
          active={pathname.startsWith("/deployments")}
        />
        <NavLink
          component={Link}
          href="/files"
          label="Data Browser"
          active={pathname === "/files"}
        />
        <NavLink
          component={Link}
          href="/upload"
          label="Upload File"
          active={pathname === "/upload"}
        />
        <NavLink
          component={Link}
          href="/settings"
          label="Settings"
          active={pathname === "/settings"}
        />
      </div>
      <SegmentedControl
        value={mode}
        onChange={(v) => setMode(v as DataSourceMode)}
        data={[
          { label: "Local", value: "local" },
          { label: "Remote", value: "remote", disabled: !remoteAvailable },
        ]}
        size="xs"
        fullWidth
      />
    </Stack>
  );
}

function ShellGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cleanupTimer: (() => void) | undefined;

    async function init() {
      try {
        const state = await getCloudSetupState();
        if (state.state === "configured") {
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
        } else {
          router.replace("/cloud-setup");
          // Keep loading=true so children never flash before navigation completes
        }
      } catch (err) {
        console.error("Failed to check cloud setup state:", err);
        router.replace("/cloud-setup");
      }
    }

    init();
    return () => cleanupTimer?.();
  }, [router]);

  if (loading) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }

  return (
    <DataSourceProvider>
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
    </DataSourceProvider>
  );
}

export default function ShellLayout({ children }: { children: ReactNode }) {
  return <ShellGate>{children}</ShellGate>;
}
