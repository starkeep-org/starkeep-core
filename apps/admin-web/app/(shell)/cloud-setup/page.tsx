"use client";

import { Suspense } from "react";
import Link from "next/link";
import { CloudSetupWizard } from "../../../src/components/CloudSetupWizard";

export default function CloudSetupPage() {
  return (
    <div className="max-w-4xl">
      <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
        ← Dashboard
      </Link>
      <h1 className="mt-2 mb-2 text-2xl font-semibold">Cloud Setup</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Point this console at an AWS account, then deploy the cloud data server into it.
      </p>
      <div className="rounded-lg border p-6">
        <Suspense>
          <CloudSetupWizard />
        </Suspense>
      </div>
    </div>
  );
}
