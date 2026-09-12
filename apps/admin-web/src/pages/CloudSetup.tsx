import { Link } from "react-router";
import { CloudSetupWizard } from "../components/CloudSetupWizard";

export function CloudSetupPage() {
  return (
    <div className="p-6 max-w-4xl">
      <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
        ← Dashboard
      </Link>
      <h1 className="mt-2 mb-2 text-2xl font-semibold">Cloud Setup</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Point this console at an AWS account, then deploy the cloud data server into it.
      </p>
      <div className="rounded-lg border p-6">
        <CloudSetupWizard />
      </div>
    </div>
  );
}
