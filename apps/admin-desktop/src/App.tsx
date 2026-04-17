import { BrowserRouter, Routes, Route, Link, useLocation } from "react-router-dom";
import {
  AppShell,
  NavLink,
  Group,
  Title,
  Badge,
} from "@mantine/core";
import { DashboardPage } from "./pages/DashboardPage";
import { DeploymentsPage } from "./pages/DeploymentsPage";
import { NewDeploymentPage } from "./pages/NewDeploymentPage";
import { PlanDetailPage } from "./pages/PlanDetailPage";
import { SettingsPage } from "./pages/SettingsPage";
import { FileBrowserPage } from "./pages/FileBrowserPage";

function AppNavbar() {
  const location = useLocation();

  return (
    <>
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
        to="/settings"
        label="Settings"
        active={location.pathname === "/settings"}
      />
    </>
  );
}

export function App() {
  return (
    <BrowserRouter>
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
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </AppShell.Main>
      </AppShell>
    </BrowserRouter>
  );
}
