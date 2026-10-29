/**
 * The address phones and other computers sign in with, shown under the Cloud
 * heading on the machine that administers the cloud, with a copy button.
 *
 * This machine reaches the cloud through the API gateway directly, and the
 * CloudFront address fronts that same gateway. The line names the CloudFront
 * address, because showing both left the person choosing between two addresses
 * with nothing to say which one a phone needs.
 */

import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CloudAddress({ address }: { address: string | null }) {
  const [copied, setCopied] = useState(false);

  if (address === null) return null;

  const copy = () => {
    void navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    });
  };

  return (
    <p className="flex flex-wrap items-center gap-1 text-sm">
      <span className="text-muted-foreground">Cloud address:</span>
      <span className="font-mono break-all">{address}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={copied ? "Copied" : "Copy address"}
        title={copied ? "Copied" : "Copy the address phones and other computers sign in with"}
        onClick={copy}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </p>
  );
}
