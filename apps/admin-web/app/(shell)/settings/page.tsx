"use client";

import { CloudSetupWizard } from "../../../src/components/CloudSetupWizard";

export default function SettingsPage() {
  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-semibold mb-6">Settings</h1>
      <div className="rounded-lg border p-6">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-5">Cloud Setup</h2>
        <CloudSetupWizard />
      </div>
    </div>
  );
}
