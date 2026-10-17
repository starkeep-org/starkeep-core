/**
 * This machine's connection to a cloud.
 *
 * A machine syncs with its own device key, which the local data server makes
 * and keeps. The cloud accepts the key once an admin approves it, in one of two
 * ways:
 *
 * - **Connect this machine.** An admin signed in here registers the key for
 *   themselves in one action.
 * - **A pairing code.** Anyone else joins a cloud by its address, shows the
 *   code, and sends it to an admin, who approves it under "Devices". This
 *   machine checks every few seconds and starts syncing once approved.
 *
 * The private half of the key never leaves the local data server; this page
 * sees only the public half, the code and the fingerprint.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { operatorSession } from "@/lib/operator-session";

interface MachineView {
  deviceId: string | null;
  publicKeySpki: string | null;
  fingerprint: string | null;
  pairingCode: string | null;
  label: string | null;
  approval:
    | { state: "no-key" | "pending" | "unknown" }
    | { state: "approved"; userId: string | null; label: string | null }
    | { state: "bound-elsewhere"; message: string };
  cloudUrl: string | null;
}

type Load = { kind: "loading" } | { kind: "offline" } | { kind: "ready"; view: MachineView };

/** How often a machine waiting for approval asks again. */
const CHECK_INTERVAL_MS = 5_000;

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<MachineView> {
  const res = await fetch(path, {
    method,
    ...(body !== undefined
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  const json = (await res.json()) as MachineView & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

export function ThisMachineSection({ canConnect }: { canConnect: boolean }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [label, setLabel] = useState("");
  const [cloudUrl, setCloudUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  const refresh = useCallback(async (check = false) => {
    try {
      const view = check
        ? await call("POST", "/api/this-machine/check")
        : await call("GET", "/api/this-machine");
      setLoad({ kind: "ready", view });
    } catch {
      setLoad({ kind: "offline" });
    }
  }, []);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  const view = load.kind === "ready" ? load.view : null;
  const waiting =
    view !== null &&
    view.pairingCode !== null &&
    view.approval.state !== "approved" &&
    view.approval.state !== "bound-elsewhere";

  // A machine showing a code asks the cloud again until an admin approves it.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void refresh(true), CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

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
      await call("POST", "/api/this-machine/cloud", { url: cloudUrl.trim() });
      // The local data server restarts to pick up the cloud.
      setRestarting(true);
      setTimeout(() => {
        setRestarting(false);
        void refresh(true);
      }, 3_000);
    });

  const makeCode = () =>
    run(async () => {
      setLoad({ kind: "ready", view: await call("POST", "/api/this-machine/key", { label: label.trim() || null }) });
    });

  const connect = () =>
    run(async () => {
      const keyed = await call("POST", "/api/this-machine/key", { label: label.trim() || null });
      const session = await operatorSession();
      const res = await fetch("/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          credentials: session.credentials,
          stackPrefix: session.stackPrefix,
          region: session.region,
          deviceId: keyed.deviceId,
          // The public half only; the local data server keeps the private half.
          publicKeySpki: keyed.publicKeySpki,
          label: keyed.label,
          kind: "desktop",
          userId: session.userSub,
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      await refresh(true);
    });

  if (load.kind === "loading") return null;
  if (load.kind === "offline") {
    return (
      <section className="rounded-lg border p-4 space-y-2" aria-label="This machine">
        <h3 className="font-medium">This machine</h3>
        <p className="text-sm text-muted-foreground">
          Start the local data server to connect this machine to a cloud.
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
      ) : v.approval.state === "bound-elsewhere" ? (
        <Alert variant="destructive">
          <AlertTitle>This machine does not sync</AlertTitle>
          <AlertDescription>{v.approval.message}</AlertDescription>
        </Alert>
      ) : v.approval.state === "approved" ? (
        <p className="text-sm" role="status">
          This machine syncs with {v.cloudUrl}
          {v.approval.label ? ` as “${v.approval.label}”` : ""}.
        </p>
      ) : (
        <>
          {v.pairingCode === null ? (
            <>
              <p className="text-sm text-muted-foreground">
                This machine does not sync yet. {canConnect
                  ? "Connect it to your own account, or show a pairing code for an admin to approve."
                  : "Show a pairing code, and send it to an admin of the cloud to approve."}
              </p>
              <Input
                placeholder="Name this machine, e.g. 'Sam's laptop'"
                value={label}
                maxLength={100}
                aria-label="Machine name"
                onChange={(e) => setLabel(e.target.value)}
                disabled={busy}
              />
            </>
          ) : (
            <div className="space-y-2">
              <p className="text-sm">
                Send this pairing code to an admin of the cloud. It holds no secret. When the admin
                approves it, they will see the fingerprint <span className="font-mono">{v.fingerprint}</span>;
                confirm that it matches.
              </p>
              <textarea
                readOnly
                className="w-full rounded-md border bg-muted p-2 font-mono text-xs"
                rows={3}
                value={v.pairingCode}
                aria-label="Pairing code"
                onFocus={(e) => e.currentTarget.select()}
              />
              <p className="text-sm text-muted-foreground" role="status">
                Waiting for an admin to approve this machine…
              </p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {canConnect && (
              <Button onClick={() => void connect()} disabled={busy}>
                {busy ? "Working…" : "Connect this machine"}
              </Button>
            )}
            {v.pairingCode === null && (
              <Button variant="outline" onClick={() => void makeCode()} disabled={busy}>
                Show a pairing code
              </Button>
            )}
          </div>
        </>
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
