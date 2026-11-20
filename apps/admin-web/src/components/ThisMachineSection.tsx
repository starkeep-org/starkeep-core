/**
 * This machine's connection to a cloud: the cloud it joined, and its sign-in.
 *
 * A machine syncs once someone signs it in with their Starkeep account. The
 * person signs in on the managed login page, which also sets a permanent
 * password at an account's first sign-in. The page returns to admin-web's
 * `/auth/callback`, and the local data server redeems the code and keeps the
 * session. No page here ever handles a password.
 *
 * A machine that does not run the cloud joins one first, by its address. The
 * owner's second computer joins this way too: only the machine that deployed
 * the cloud administers it. The dashboard opens the join form from a button
 * beside the Deploy button, which names the form, so the form drops its heading.
 *
 * On the machine that administers the cloud, the sign-in sits as a line under
 * the Local heading rather than in a card of its own, because signing in is
 * how the local apps start to sync. This machine reaches that cloud through the
 * API gateway directly, so the line says "this cloud" instead of the gateway's
 * address, which is not the address other devices sign in with.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { readAdminSession, syncSignInUrl } from "@/lib/admin-session-client";

interface MachineView {
  cloudUrl: string | null;
  state: "signed-out" | "connecting" | "signed-in" | "bound-elsewhere";
  email: string | null;
  message?: string;
}

type Load = { kind: "loading" } | { kind: "offline" } | { kind: "ready"; view: MachineView };

/** How often a machine that is still connecting asks again. */
const CHECK_INTERVAL_MS = 5_000;

async function post(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json()) as Record<string, unknown> & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

export function ThisMachineSection({
  administering = false,
  untitled = false,
}: {
  /** This machine administers the cloud, and the section sits under the Local heading. */
  administering?: boolean;
  /** Something beside the section already names it, so it shows no heading of its own. */
  untitled?: boolean;
} = {}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [cloudUrl, setCloudUrl] = useState("");
  // Why this admin-web cannot receive the sign-in page's redirect, if it cannot.
  const [signInUnavailable, setSignInUnavailable] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/this-machine", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setLoad({ kind: "ready", view: (await res.json()) as MachineView });
    } catch {
      setLoad({ kind: "offline" });
    }
  }, []);

  useEffect(() => {
    void refresh();
    void readAdminSession().then((s) =>
      setSignInUnavailable(s.browserSignIn.available ? null : (s.browserSignIn.reason ?? null)),
    );
  }, [refresh]);

  const view = load.kind === "ready" ? load.view : null;

  // A machine signed in but not yet bound to its user asks again until it is.
  useEffect(() => {
    if (view?.state !== "connecting") return;
    const timer = setInterval(() => void refresh(), CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [view?.state, refresh]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const join = () =>
    run(async () => {
      await post("/api/this-machine/cloud", { url: cloudUrl.trim() });
      // The local data server restarts to pick up the cloud.
      setRestarting(true);
      setTimeout(() => {
        setRestarting(false);
        void refresh();
      }, 3_000);
    });

  const signOut = () =>
    run(async () => {
      await post("/api/this-machine/sign-out");
      await refresh();
    });

  const signOutLink = (
    <Button
      variant="link"
      size="sm"
      className="h-auto p-0"
      onClick={() => void signOut()}
      disabled={busy}
    >
      Sign out
    </Button>
  );

  if (load.kind === "loading") return null;
  if (load.kind === "offline") {
    if (administering) {
      return (
        <p className="text-sm text-muted-foreground">
          Start the local data server to sign this machine in.
        </p>
      );
    }
    return (
      <section className="rounded-lg border p-4 space-y-2" aria-label="This machine">
        {!untitled && <h3 className="font-medium">This machine</h3>}
        <p className="text-sm text-muted-foreground">
          Start the local data server to join a cloud or sign this machine in.
        </p>
      </section>
    );
  }
  const v = load.view;
  // On the administering machine, "this cloud" names it; a joined machine names
  // the address it joined with, which is the one its admin sent.
  const cloudName = administering ? "this cloud" : v.cloudUrl;

  return (
    <section
      className={administering ? "space-y-3" : "rounded-lg border p-4 space-y-3"}
      aria-label="This machine"
    >
      {!administering && !untitled && <h3 className="font-medium">This machine</h3>}

      {restarting ? (
        <p className="text-sm text-muted-foreground" role="status">
          Restarting the local data server…
        </p>
      ) : v.cloudUrl === null ? (
        <>
          <p className="text-sm text-muted-foreground">
            Already deployed Starkeep Cloud from another computer, or have an account on someone
            else&apos;s cloud? Enter the cloud&apos;s address to sync this computer with it.
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="https://…"
              value={cloudUrl}
              aria-label="Cloud address"
              onChange={(e) => setCloudUrl(e.target.value)}
              disabled={busy}
            />
            <Button onClick={() => void join()} disabled={busy || cloudUrl.trim() === ""}>
              Join
            </Button>
          </div>
        </>
      ) : v.state === "bound-elsewhere" ? (
        <>
          <Alert variant="destructive">
            <AlertTitle>This machine does not sync</AlertTitle>
            <AlertDescription>{v.message}</AlertDescription>
          </Alert>
          {signOutLink}
        </>
      ) : v.state === "signed-in" || v.state === "connecting" ? (
        <p className="text-sm">
          <span role="status">
            {v.state === "signed-in"
              ? `Local apps sync with ${cloudName} as ${v.email ?? "you"}.`
              : `Signed in as ${v.email ?? "you"}. Connecting to ${cloudName}…`}
          </span>{" "}
          {signOutLink}
        </p>
      ) : (
        <div className="space-y-2" aria-label="Sign in to sync">
          <p className="text-sm text-muted-foreground">
            Sign in with your Starkeep account to sync local apps with {cloudName}. The sign-in
            opens in this browser.
          </p>
          {signInUnavailable ? (
            <p className="text-sm text-muted-foreground">{signInUnavailable}</p>
          ) : (
            <Button asChild>
              <a href={syncSignInUrl()}>Sign in to sync</a>
            </Button>
          )}
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Could not complete</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}
