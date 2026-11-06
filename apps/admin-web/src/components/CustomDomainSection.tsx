/**
 * The cloud's custom domain, such as photos.example.com, beside its
 * cloudfront.net name.
 *
 * Every change runs the cloud data server install, which acts on the domain in
 * `~/.starkeep/config.json` and reports back in `customDomainStatus`. A domain
 * whose zone sits in Route53 in the deployment's AWS account goes live in that
 * one run. A domain hosted anywhere else takes two runs: the first requests a
 * certificate and shows the record that proves ownership, and "Finish" attaches
 * the domain once the certificate is issued. The operator then points the
 * domain at the distribution with a CNAME. "Check now" reads the certificate
 * and the domain's DNS, as the signed-in operator.
 *
 * The cloudfront.net name keeps working throughout, so nothing sent before the
 * domain breaks. Removing the domain breaks every link sent with it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CommandOutput } from "./CommandOutput";
import { operatorSession } from "@/lib/operator-session";
import { readCloudConfig, type CloudConfig } from "@/lib/cloud-config";
import { runInstallStream } from "@/lib/install-stream-client";
import { ACTION_OCCASIONAL } from "@/lib/action-colors";

interface Check {
  certificateStatus?: string;
  pointsAtDistribution: boolean;
}

/**
 * Marks an update this tab started, kept across a page reload. In development
 * the install restarts admin-web, and the page reloads with it. The marker
 * lets the section follow the run again, or report how it ended.
 */
const RUN_MARKER = "starkeep.custom-domain-run";

/** A marker older than this belongs to a run long over. */
const RUN_MARKER_MAX_AGE_MS = 60 * 60_000;

function readRunMarker(): boolean {
  try {
    const at = Number(sessionStorage.getItem(RUN_MARKER));
    return at > 0 && Date.now() - at <= RUN_MARKER_MAX_AGE_MS;
  } catch {
    return false;
  }
}

function writeRunMarker(running: boolean): void {
  try {
    if (running) sessionStorage.setItem(RUN_MARKER, String(Date.now()));
    else sessionStorage.removeItem(RUN_MARKER);
  } catch {
    // Without storage, a reload mid-update loses the output, not the run.
  }
}

/** A DNS record to copy into the domain's provider. */
function RecordLine({ name, type, value }: { name: string; type: string; value: string }) {
  const [copied, setCopied] = useState<"name" | "value" | null>(null);
  const copy = (which: "name" | "value", text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(which);
      setTimeout(() => setCopied(null), 2_000);
    });
  };
  return (
    <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1 rounded-md border bg-muted/40 p-2 text-sm">
      <dt className="text-muted-foreground">Type</dt>
      <dd className="font-mono">{type}</dd>
      <span />
      <dt className="text-muted-foreground">Name</dt>
      <dd className="font-mono break-all">{name}</dd>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={copied === "name" ? "Copied" : "Copy name"}
        onClick={() => copy("name", name)}
      >
        {copied === "name" ? <CheckIcon /> : <CopyIcon />}
      </Button>
      <dt className="text-muted-foreground">Value</dt>
      <dd className="font-mono break-all">{value}</dd>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={copied === "value" ? "Copied" : "Copy value"}
        onClick={() => copy("value", value)}
      >
        {copied === "value" ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </dl>
  );
}

export function CustomDomainSection({ onChanged }: { onChanged: () => void }) {
  const [config, setConfig] = useState<CloudConfig | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [run, setRun] = useState<{
    lines: string[];
    status: "running" | "success" | "failure";
  } | null>(null);

  const load = useCallback(async () => {
    const cfg = await readCloudConfig();
    setConfig(cfg);
    setInput(cfg?.customDomain ?? "");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Save the domain, or clear it with null. */
  async function saveDomain(domain: string | null): Promise<boolean> {
    const res = await fetch("/api/custom-domain", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain }),
    });
    if (res.ok) return true;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setError(body.error ?? `Saving the domain failed (${res.status}).`);
    return false;
  }

  /**
   * Run the cloud data server install, which acts on the saved domain.
   * `reattach` follows a run this tab started before a reload.
   */
  async function update(reattach = false) {
    setRun({ lines: [], status: "running" });
    setCheck(null);
    writeRunMarker(true);
    try {
      const { credentials } = await operatorSession();
      const outcome = await runInstallStream(
        "/api/cloud-data-server/install",
        {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          sessionToken: credentials.sessionToken,
          ...(reattach ? { reattach: true } : {}),
        },
        {
          onLine: (line) => setRun((r) => (r ? { ...r, lines: [...r.lines, line] } : r)),
        },
      );
      if (outcome.kind === "done") {
        setRun((r) => (r ? { ...r, status: "success" } : r));
      } else {
        setRun((r) =>
          r ? { lines: [...r.lines, `Error: ${outcome.message}`], status: "failure" } : r,
        );
      }
    } catch (err) {
      setRun((r) =>
        r
          ? {
              lines: [...r.lines, `Error: ${err instanceof Error ? err.message : String(err)}`],
              status: "failure",
            }
          : r,
      );
    }
    writeRunMarker(false);
    await load();
    onChanged();
  }

  // An update under way when the page reloaded shows its progress again.
  const resumeChecked = useRef(false);
  useEffect(() => {
    if (resumeChecked.current) return;
    resumeChecked.current = true;
    if (!readRunMarker()) return;
    setBusy(true);
    void update(true).finally(() => setBusy(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(step: () => Promise<boolean | void>) {
    setBusy(true);
    setError(null);
    try {
      if ((await step()) !== false) await update();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function checkNow() {
    setBusy(true);
    setError(null);
    try {
      const { credentials } = await operatorSession();
      const res = await fetch("/api/custom-domain/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials }),
      });
      const body = (await res.json()) as Check & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `The check failed (${res.status}).`);
      setCheck(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!config) return null;
  const domain = config.customDomain;
  const status = config.customDomainStatus;
  const applied = !!domain && status?.name === domain;
  const issued = check?.certificateStatus === "ISSUED";

  let body: React.ReactNode;
  if (!domain && status) {
    // Cleared, but the install that drops the domain has not finished.
    body = (
      <>
        <p className="text-sm">
          The cloud still answers on <span className="font-mono">{status.name}</span>. Update the
          cloud to finish removing the domain.
        </p>
        <div>
          <Button
            className={ACTION_OCCASIONAL}
            disabled={busy}
            onClick={() => void act(async () => {})}
          >
            Update cloud
          </Button>
        </div>
      </>
    );
  } else if (!domain || !applied) {
    body = (
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => saveDomain(input.trim()));
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="min-w-56 max-w-sm flex-1"
            placeholder="www.example.com"
            aria-label="Custom domain"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
          />
          <Button
            type="submit"
            className={ACTION_OCCASIONAL}
            disabled={busy || input.trim() === ""}
          >
            Set up
          </Button>
        </div>
        {domain && !applied && (
          <p className="text-xs text-muted-foreground">
            The cloud has not set up {domain} yet. Press "Set up" to run the update.
          </p>
        )}
      </form>
    );
  } else if (status?.status === "pending-validation") {
    const record = status.validationRecord;
    body = (
      <>
        <p className="text-sm">
          Prove that you own <span className="font-mono">{domain}</span>: add this record at your
          DNS provider, then press "Check now". The certificate usually issues within minutes of the
          record appearing.
        </p>
        {record && <RecordLine name={record.name} type={record.type} value={record.value} />}
        {check && (
          <p className="text-sm" role="status">
            {issued
              ? 'The certificate is issued. Press "Finish" to attach the domain.'
              : `The certificate is not issued yet (${check.certificateStatus ?? "unknown"}).`}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={() => void checkNow()}>
            Check now
          </Button>
          <Button
            className={ACTION_OCCASIONAL}
            disabled={busy || !issued}
            onClick={() => void act(async () => {})}
          >
            Finish
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setConfirmRemove(true)}>
            Cancel
          </Button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <p className="text-sm">
          The cloud answers on <span className="font-mono">{domain}</span>.
        </p>
        {status?.mode === "external" && (
          <>
            <p className="text-sm text-muted-foreground">
              Point the domain at the cloud with this record at your DNS provider. A reinstall of
              the cloud changes the value.
            </p>
            <RecordLine name={domain} type="CNAME" value={status.aliasTarget} />
            {check && (
              <p className="text-sm" role="status">
                {check.pointsAtDistribution
                  ? `${domain} reaches the cloud.`
                  : `${domain} does not reach the cloud yet. DNS changes can take a while to spread.`}
              </p>
            )}
          </>
        )}
        <div className="flex flex-wrap gap-2">
          {status?.mode === "external" && (
            <Button variant="outline" disabled={busy} onClick={() => void checkNow()}>
              Check now
            </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={() => setConfirmRemove(true)}>
            Remove
          </Button>
        </div>
      </>
    );
  }

  return (
    <Collapsible className="flex flex-col gap-4">
      <CollapsibleTrigger className="group flex items-center gap-2 self-start text-left">
        <h2 className="text-lg font-medium">Custom Domain</h2>
        <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>

      <CollapsibleContent className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        {body}
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Custom domain</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CollapsibleContent>

      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove {domain}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Every link sent with {domain} stops working. Links on the cloud's cloudfront.net address
            keep working.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmRemove(false)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmRemove(false);
                setInput("");
                void act(() => saveDomain(null));
              }}
            >
              Remove
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={run !== null}
        onOpenChange={(open) => !open && run?.status !== "running" && setRun(null)}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Updating the cloud</DialogTitle>
          </DialogHeader>
          {run && <CommandOutput lines={run.lines} status={run.status} className="h-96" />}
          <div className="flex justify-end">
            <Button disabled={run?.status === "running"} onClick={() => setRun(null)}>
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Collapsible>
  );
}
