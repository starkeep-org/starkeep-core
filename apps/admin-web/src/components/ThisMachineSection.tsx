/**
 * This machine's connection to a cloud: the cloud it joined, and its sign-in.
 *
 * A machine syncs once someone signs it in with their Starkeep account. The
 * local data server signs in through the pool's device client and keeps the
 * session; this page collects the email and password and passes them through
 * admin-web's server, and never stores either. An account an admin just
 * created answers its first sign-in with a request for a new password, which
 * this form asks for in place.
 *
 * A machine that does not run the cloud joins one first, by the address its
 * admin sent.
 */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

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

export function ThisMachineSection() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [cloudUrl, setCloudUrl] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [needsNewPassword, setNeedsNewPassword] = useState(false);
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

  const signIn = (event: FormEvent) => {
    event.preventDefault();
    if (needsNewPassword && newPassword !== confirmPassword) {
      setError("The two new passwords do not match.");
      return;
    }
    void run(async () => {
      const answer = await post("/api/this-machine/sign-in", {
        email: email.trim(),
        password,
        ...(needsNewPassword ? { newPassword } : {}),
      });
      if (answer["challenge"] === "NEW_PASSWORD_REQUIRED") {
        setNeedsNewPassword(true);
        return;
      }
      setPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setNeedsNewPassword(false);
      await refresh();
    });
  };

  const signOut = () =>
    run(async () => {
      await post("/api/this-machine/sign-out");
      await refresh();
    });

  if (load.kind === "loading") return null;
  if (load.kind === "offline") {
    return (
      <section className="rounded-lg border p-4 space-y-2" aria-label="This machine">
        <h3 className="font-medium">This machine</h3>
        <p className="text-sm text-muted-foreground">
          Start the local data server to sign this machine in to a cloud.
        </p>
      </section>
    );
  }
  const v = load.view;

  return (
    <section className="rounded-lg border p-4 space-y-3" aria-label="This machine">
      <h3 className="font-medium">This machine</h3>

      {restarting ? (
        <p className="text-sm text-muted-foreground" role="status">
          Restarting the local data server…
        </p>
      ) : v.cloudUrl === null ? (
        <>
          <p className="text-sm text-muted-foreground">
            To sync with a Starkeep cloud someone else runs, enter the address its admin sent you.
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
          <Button variant="outline" onClick={() => void signOut()} disabled={busy}>
            Sign out
          </Button>
        </>
      ) : v.state === "signed-in" || v.state === "connecting" ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm" role="status">
            {v.state === "signed-in"
              ? `This machine syncs with ${v.cloudUrl} as ${v.email ?? "you"}.`
              : `Signed in as ${v.email ?? "you"}. Connecting to ${v.cloudUrl}…`}
          </p>
          <Button variant="outline" size="sm" onClick={() => void signOut()} disabled={busy}>
            Sign out
          </Button>
        </div>
      ) : (
        <form className="space-y-2" onSubmit={signIn} aria-label="Sign in to sync">
          <p className="text-sm text-muted-foreground">
            {needsNewPassword
              ? "This is the account's first sign-in. Choose a new password to replace the temporary one."
              : `Sign in with your Starkeep account to sync this machine with ${v.cloudUrl}.`}
          </p>
          <Input
            type="email"
            autoComplete="username"
            placeholder="Email"
            aria-label="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy || needsNewPassword}
          />
          <Input
            type="password"
            autoComplete="current-password"
            placeholder={needsNewPassword ? "Temporary password" : "Password"}
            aria-label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy || needsNewPassword}
          />
          {needsNewPassword && (
            <>
              <Input
                type="password"
                autoComplete="new-password"
                placeholder="New password, at least 8 characters"
                aria-label="New password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={busy}
              />
              <Input
                type="password"
                autoComplete="new-password"
                placeholder="New password again"
                aria-label="Confirm new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={busy}
              />
            </>
          )}
          <Button
            type="submit"
            disabled={
              busy || email.trim() === "" || password === "" || (needsNewPassword && newPassword.length < 8)
            }
          >
            {busy ? "Signing in…" : needsNewPassword ? "Set password and sign in" : "Sign in to sync"}
          </Button>
        </form>
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
