"use client";

import { CloudSetupWizard } from "../../../src/components/CloudSetupWizard";
import { CapabilityModelsSection } from "../../../src/components/CapabilityModelsSection";
import { CapabilityGatesSection } from "../../../src/components/CapabilityGatesSection";
import { BedrockBudgetSection } from "../../../src/components/BedrockBudgetSection";

export default function SettingsPage() {
  return (
    <div className="max-w-5xl flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <div className="rounded-lg border p-6">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-5">Cloud Setup</h2>
        <CloudSetupWizard />
      </div>
      {/* Above Capability Limits on purpose: the hard, structural ceiling should
          read before the soft ones it backstops. */}
      <div className="rounded-lg border p-6">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-5">Bedrock Spend Guardrail</h2>
        <BedrockBudgetSection />
      </div>
      <div className="rounded-lg border p-6">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-5">Capability Limits</h2>
        <CapabilityGatesSection />
      </div>
      <div className="rounded-lg border p-6">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-5">Capability Models</h2>
        <CapabilityModelsSection />
      </div>
    </div>
  );
}
