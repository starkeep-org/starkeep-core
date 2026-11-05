/**
 * Every public link in the deployment, across apps and people, each one
 * revocable.
 *
 * A public link shows an app's labelled records, such as a Photos album, or
 * one record, to anyone holding it. People create and manage their own from
 * the app; this list is the operator's audit of all of them. "Turn off"
 * deletes the link: new visits fail at once, and pages the edge already
 * cached stop within a minute.
 *
 * The section also holds the switch that lets Starkeep Drive create public
 * links. Drive reaches every file, including photo and video originals, so the
 * switch starts off.
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { operatorSession } from "@/lib/operator-session";

interface PublicShareView {
  readonly id: string;
  readonly appId: string;
  readonly ownerUserId: string;
  readonly title: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number | null;
}

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; shares: readonly PublicShareView[] }
  | { kind: "error"; message: string };

async function call(path: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  const { credentials } = await operatorSession();
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      ...extra,
    }),
  });
  const body = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${path} failed: ${res.status}`);
  return body;
}

/** "Expires 12 Nov 2026", "Expired", or "Never expires". */
export function expiryText(expiresAtMs: number | null, nowMs: number): string {
  if (expiresAtMs === null) return "Never expires";
  if (expiresAtMs <= nowMs) return "Expired";
  return `Expires ${new Date(expiresAtMs).toLocaleDateString(undefined, { dateStyle: "medium" })}`;
}

export function PublicSharesSection() {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Null until the first answer, so the switch never shows a guess.
  const [driveEnabled, setDriveEnabled] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    try {
      const body = (await call("/api/public-shares/list")) as { publicShares: PublicShareView[] };
      setList({ kind: "ready", shares: body.publicShares });
    } catch (err) {
      setList({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
    try {
      const body = (await call("/api/public-shares/drive-capability")) as { enabled: boolean };
      setDriveEnabled(body.enabled);
    } catch {
      setDriveEnabled(null);
    }
  }, []);

  const setDrive = async (enabled: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      const body = (await call("/api/public-shares/drive-capability", { enabled })) as {
        enabled: boolean;
      };
      setDriveEnabled(body.enabled);
      setMessage(
        body.enabled
          ? "Drive can now create public links."
          : "Drive can no longer create public links. Its existing links stop working.",
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (share: PublicShareView) => {
    if (!confirm(`Turn off the public link "${share.title}"? Anyone holding it loses access.`)) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await call("/api/public-shares/revoke", { id: share.id });
      setMessage(`Turned off "${share.title}".`);
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const now = Date.now();
  return (
    <Collapsible className="flex flex-col gap-4">
      <CollapsibleTrigger className="group flex items-center gap-2 self-start text-left">
        <h2 className="text-lg font-medium">Public Links</h2>
        <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>

      <CollapsibleContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Anyone holding one of these links can see what it shows without signing in.
        </p>
        <label className="flex items-start gap-3 rounded-lg border bg-card p-3 text-sm">
          <input
            type="checkbox"
            role="switch"
            className="mt-0.5 size-4"
            checked={driveEnabled === true}
            disabled={busy || driveEnabled === null}
            onChange={(e) => void setDrive(e.target.checked)}
          />
          <span>
            Allow Drive to create public links to any file in your library, including photo and
            video originals.
          </span>
        </label>
        {message && (
          <p className="text-sm" role="status">
            {message}
          </p>
        )}
        {list.kind === "loading" ? (
          <p className="text-muted-foreground text-sm">Loading public links…</p>
        ) : list.kind === "error" ? (
          <Alert variant="destructive">
            <AlertTitle>Could not load public links</AlertTitle>
            <AlertDescription>{list.message}</AlertDescription>
          </Alert>
        ) : list.shares.length === 0 ? (
          <p className="text-sm">No public links.</p>
        ) : (
          <ul className="divide-y rounded-lg border bg-card" aria-label="Public links">
            {list.shares.map((share) => (
              <li key={share.id} className="flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{share.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {share.appId} · owner {share.ownerUserId} · {expiryText(share.expiresAtMs, now)}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void revoke(share)}
                >
                  Turn off
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
