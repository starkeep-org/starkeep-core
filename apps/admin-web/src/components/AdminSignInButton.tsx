/**
 * The way back in when an action needs the admin session: a button that opens
 * the managed login page and returns here. An admin-web that cannot receive the
 * page's redirect (another port than Cognito knows) says why instead.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { adminSignInUrl, readAdminSession } from "@/lib/admin-session-client";

export function AdminSignInButton({
  label = "Sign in as admin",
  variant = "default",
}: {
  label?: string;
  variant?: "default" | "outline";
}) {
  const [unavailable, setUnavailable] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void readAdminSession().then((s) => {
      if (live && !s.browserSignIn.available) setUnavailable(s.browserSignIn.reason ?? null);
    });
    return () => {
      live = false;
    };
  }, []);

  if (unavailable) return <p className="text-sm text-muted-foreground">{unavailable}</p>;
  return (
    <Button variant={variant} onClick={() => window.location.assign(adminSignInUrl())}>
      {label}
    </Button>
  );
}
