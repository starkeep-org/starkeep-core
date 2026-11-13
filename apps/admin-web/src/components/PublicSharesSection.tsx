/**
 * Every public link in the deployment, across apps and people, each one
 * revocable.
 *
 * A public link shows an app's labelled records, such as a Photos album, or
 * one record, to anyone holding it. People create and manage their own from
 * the app; this list is the operator's audit of all of them. "Turn off"
 * deletes the link: new visits fail at once, and pages the edge already
 * cached stop within a minute.
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
  readonly source:
    | { readonly kind: "label"; readonly key: string; readonly value: string }
    | { readonly kind: "record"; readonly recordId: string };
  readonly serves: "stand-in" | "original";
  readonly title: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number | null;
}

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; shares: readonly PublicShareView[] }
  | { kind: "error"; message: string };

/** POSTs to an admin-web route with the signed-in operator's credentials. */
export async function postAsOperator(
  path: string,
  extra: Record<string, unknown> = {},
): Promise<unknown> {
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

/**
 * What a link shows: one record or a label's records, and whether a visitor
 * gets an original. A label's link always serves stand-ins, and a file's link
 * always serves its original, because a file has no stand-in.
 */
export function sharesText(share: Pick<PublicShareView, "source" | "serves">): string {
  if (share.source.kind === "label") return `Label ${share.source.key}, stand-ins`;
  return share.serves === "original" ? "One file, original" : "One file, stand-in";
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

  const load = useCallback(async () => {
    try {
      const body = (await postAsOperator("/api/public-shares/list")) as {
        publicShares: PublicShareView[];
      };
      setList({ kind: "ready", shares: body.publicShares });
    } catch (err) {
      setList({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

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
      await postAsOperator("/api/public-shares/revoke", { id: share.id });
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
          Anyone who has a valid link can view the shared content without signing in.
        </p>
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
                    {share.appId} · {sharesText(share)} · owner {share.ownerUserId} ·{" "}
                    {expiryText(share.expiresAtMs, now)}
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
