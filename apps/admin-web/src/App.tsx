/**
 * The client route table.
 *
 * Three pages under one shell, which is what the `app/(shell)/` route group
 * expressed: the header and the credential-refresh gate wrap every page, and
 * each page brings its own ground and padding.
 *
 * `<Shell>` is a layout route rather than a component each page renders, so the
 * gate mounts once and a navigation between pages does not re-run it — the same
 * lifetime a route-group layout had.
 */

import { Route, Routes } from "react-router";
import { Shell } from "./components/Shell";
import { Toaster } from "@/components/ui/sonner";
import { DashboardPage } from "./pages/Dashboard";
import { CloudSetupPage } from "./pages/CloudSetup";
import { StoragePage } from "./pages/Storage";

export function App() {
  return (
    <>
      <Routes>
        <Route element={<Shell />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/cloud-setup" element={<CloudSetupPage />} />
          <Route path="/storage" element={<StoragePage />} />
        </Route>
      </Routes>
      <Toaster />
    </>
  );
}
