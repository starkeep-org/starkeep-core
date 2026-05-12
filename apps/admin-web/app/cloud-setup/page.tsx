"use client";

import { Suspense } from "react";
import { CloudSetupWizard } from "../../src/components/CloudSetupWizard";

export default function CloudSetupPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b px-6 py-4 shrink-0">
        <h1 className="font-semibold text-lg">Starkeep Cloud Setup</h1>
      </header>
      <main className="flex-1 px-6 py-8 max-w-4xl mx-auto w-full">
        <Suspense>
          <CloudSetupWizard />
        </Suspense>
      </main>
    </div>
  );
}
