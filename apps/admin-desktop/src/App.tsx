import { useEffect, useState, useContext } from "react";
import { BrowserRouter, Routes, Route, Link, useLocation } from "react-router-dom";
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
import { DataSourceProvider, DataSourceContext } from "./lib/data-source-context";
import type { DataSourceMode } from "./lib/data-client";
import { DashboardPage } from "./pages/DashboardPage";
import { DeploymentsPage } from "./pages/DeploymentsPage";
import { NewDeploymentPage } from "./pages/NewDeploymentPage";
import { PlanDetailPage } from "./pages/PlanDetailPage";
import { SettingsPage } from "./pages/SettingsPage";
import { FileBrowserPage } from "./pages/FileBrowserPage";
import { CloudSetupPage } from "./pages/CloudSetupPage";
import { UploadFilePage } from "./pages/UploadFilePage";
import { getCloudSetupState } from "./lib/cloud-config";
import {
  readCloudConfig,
  readCloudCredentials,
  writeCloudCredentials,
} from "./lib/cloud-config";
import { refreshTokens, getIdentityPoolCredentials, startCredentialRefreshTimer } from "./lib/cognito-auth";

function AppNavbar() {
  const location = useLocation();
  const { mode, setMode, remoteAvailable } = useContext(DataSourceContext);

  return (
    <Stack h="100%" justify="space-between">
      <div>
        <NavLink
          component={Link}
          to="/"
          label="Dashboard"
          active={location.pathname === "/"}
        />
        <NavLink
          component={Link}
          to="/deployments"
          label="Deployments"
          active={location.pathname.startsWith("/deployments")}
        />
        <NavLink
          component={Link}
          to="/files"
          label="Data Browser"
          active={location.pathname === "/files"}
        />
        <NavLink
          component={Link}
          to="/upload"
          label="Upload File"
          active={location.pathname === "/upload"}
        />
        <NavLink
          component={Link}
          to="/settings"
          label="Settings"
          active={location.pathname === "/settings"}
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

/**
 * Gate component that checks cloud setup state on mount.
 * - If not configured → renders the CloudSetupPage full-screen.
 * - If configured → renders the main app shell with all routes.
 *
 * After a successful sign-in the gate also starts the background credential
 * refresh timer so STS credentials stay fresh (rotated every 45 min).
 */
function CloudSetupGate() {
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    let cleanupTimer: (() => void) | undefined;

    async function init() {
      try {
        const state = await getCloudSetupState();
        if (state.state === "configured") {
          setConfigured(true);

          // Start background credential refresh if we have a config.
          const config = await readCloudConfig();
          if (config?.cognitoRefreshToken && config.cognitoConfig) {
            cleanupTimer = startCredentialRefreshTimer(
              config.cognitoConfig,
              () => config.cognitoRefreshToken,
              async (newCreds) => {
                await writeCloudCredentials(newCreds).catch(console.error);
              },
              (err) => console.warn("Credential refresh failed:", err)
            );
          }
        }
      } catch (err) {
        // Outside the Tauri runtime (plain browser dev), Tauri IPC is unavailable —
        // fall through silently and show the setup wizard.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Tauri not available")) {
          console.error("Failed to check cloud setup state:", err);
        }
        // Fall through to show setup wizard on error
      } finally {
        setLoading(false);
      }
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

  if (!configured) {
    return (
      <Routes>
        <Route path="*" element={<CloudSetupPage />} />
      </Routes>
    );
  }

  return (
    <DataSourceProvider>
    <AppShell
      navbar={{ width: 220, breakpoint: "sm" }}
      header={{ height: 56 }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="xs">
            <Title order={4}>Starkeep Admin</Title>
            <Badge variant="light" size="sm">Desktop</Badge>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        <AppNavbar />
      </AppShell.Navbar>

      <AppShell.Main>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/deployments" element={<DeploymentsPage />} />
          <Route path="/deployments/new" element={<NewDeploymentPage />} />
          <Route path="/deployments/:planId" element={<PlanDetailPage />} />
          <Route path="/files" element={<FileBrowserPage />} />
          <Route path="/upload" element={<UploadFilePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/cloud-setup" element={<CloudSetupPage />} />
        </Routes>
      </AppShell.Main>
    </AppShell>
    </DataSourceProvider>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <CloudSetupGate />
    </BrowserRouter>
  );
}
