/**
 * The shell every page renders inside: the header, the app-discovery control,
 * and the notice a browser sign-in leaves when it returns.
 *
 * A layout route rather than a wrapper each page renders, which is what
 * `app/(shell)/layout.tsx` was. Its effect runs once for the session rather
 * than once per navigation.
 */

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link, Outlet } from "react-router";
import { Badge } from "@/components/ui/badge";
import { AppDiscovery } from "./AppDiscovery";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { forgetBrowserSession } from "../lib/admin-session-client";

/**
 * What `/auth/callback` reported, from the query it returned with: a sign-in
 * that failed, with the reason, or one that succeeded. The query is removed
 * from the address bar once read, so a reload does not repeat the notice.
 */
function readSignInNotice(): { error: string | null; signedIn: string | null } {
  const params = new URLSearchParams(window.location.search);
  const error = params.get("signInError");
  const signedIn = params.get("signedIn");
  if (error !== null || signedIn !== null) {
    params.delete("signInError");
    params.delete("signedIn");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
  }
  return { error, signedIn };
}

function ShellGate({ children }: { children: ReactNode }) {
  const [signInError, setSignInError] = useState<string | null>(null);

  useEffect(() => {
    forgetBrowserSession();
    setSignInError(readSignInNotice().error);
  }, []);

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex h-14 items-center justify-between border-b px-6 shrink-0">
        <Link to="/" className="flex items-center gap-2">
          <span className="font-semibold">Starkeep Admin</span>
          <Badge variant="secondary" className="text-xs">
            Web
          </Badge>
        </Link>
        <AppDiscovery />
      </header>

      {/* Each page brings its own ground and padding. The dashboard lays cards
          on the off-white surface so they read as cards; the detail pages carry
          prose and forms, which read as a document on the page background. */}
      <main className="flex-1 overflow-y-auto">
        {signInError && (
          <div className="px-6 pt-4">
            <Alert variant="destructive">
              <AlertDescription className="flex items-start justify-between gap-4">
                <span>Sign-in did not finish: {signInError}</span>
                <button
                  type="button"
                  className="text-sm underline"
                  onClick={() => setSignInError(null)}
                >
                  Dismiss
                </button>
              </AlertDescription>
            </Alert>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}

export function Shell() {
  return (
    <ShellGate>
      <Outlet />
    </ShellGate>
  );
}
