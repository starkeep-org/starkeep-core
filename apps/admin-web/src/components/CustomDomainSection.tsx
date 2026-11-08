/**
 * The cloud's custom domain, such as photos.example.com, beside its
 * cloudfront.net name.
 *
 * Every change runs the cloud data server install, which acts on the domain in
 * `~/.starkeep/config.json` and reports back in `customDomainStatus`. A domain
 * whose zone sits in Route53 in the deployment's AWS account goes live in that
 * one run. A domain hosted anywhere else takes two runs: the first requests a
 * certificate and shows two records, the one that proves ownership and the
 * CNAME that points the domain at the distribution. "Finish" attaches the
 * domain once the certificate is issued and the CNAME resolves, so the domain
 * becomes the canonical host only when it works. "Check now" reads the
 * certificate and the domain's DNS, as the signed-in operator.
 *
 * "Set up" first asks which case applies, then confirms before it saves. For a
 * domain in an account zone, the dialog names the records the install adds
 * there. For any other domain, it lists the steps at the operator's provider.
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
  /** The domain "Set up" waits to save until the operator approves, and its account zone. */
  const [confirmSetUp, setConfirmSetUp] = useState<{
    domain: string;
    zone: string | null;
  } | null>(null);
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

  /**
   * Clear a saved domain no install has applied. The cloud never answered on
   * it, so the change needs no update; the section offers one only if an
   * earlier domain is still attached.
   */
  async function removeUnapplied() {
    setBusy(true);
    setError(null);
    try {
      if (await saveDomain(null)) {
        setInput("");
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  /**
   * Find whether the domain's zone lives in this account, so the confirmation
   * describes the case that applies.
   */
  async function setUp(raw: string) {
    setBusy(true);
    setError(null);
    let found: { domain: string; zone: string | null };
    try {
      const { credentials } = await operatorSession();
      const res = await fetch("/api/custom-domain/zone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain: raw, credentials }),
      });
      const body = (await res.json()) as {
        domain: string;
        zone: string | null;
        error?: string;
      };
      if (!res.ok)
        throw new Error(body.error ?? `Finding the domain's zone failed (${res.status}).`);
      found = body;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      return;
    }
    setBusy(false);
    setConfirmSetUp(found);
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
  const pointed = check?.pointsAtDistribution === true;
  const cnameReport =
    check &&
    (pointed
      ? `${domain} points at the cloud.`
      : `${domain} does not point at the cloud yet. DNS changes can take a while to spread.`);

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
          void setUp(input);
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
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-muted-foreground">
              The cloud has not set up {domain} yet. Press "Set up" to run the update.
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void removeUnapplied()}
            >
              Remove
            </Button>
          </div>
        )}
      </form>
    );
  } else if (status?.status === "pending-validation") {
    const record = status.validationRecord;
    body = (
      <>
        <p className="text-sm">
          Add these two records at your DNS provider for <span className="font-mono">{domain}</span>
          , then press "Check now". The first proves you own the domain, and the certificate usually
          issues within minutes of it appearing. The second points the domain at the cloud.
        </p>
        {record && <RecordLine name={record.name} type={record.type} value={record.value} />}
        <RecordLine name={domain} type="CNAME" value={status.aliasTarget} />
        {check && (
          <div className="text-sm" role="status">
            <p>
              {issued
                ? "The certificate is issued."
                : `The certificate is not issued yet (${check.certificateStatus ?? "unknown"}).`}
            </p>
            <p>{cnameReport}</p>
            {issued && pointed && <p>Press "Finish" to attach the domain.</p>}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={() => void checkNow()}>
            Check now
          </Button>
          <Button
            className={ACTION_OCCASIONAL}
            disabled={busy || !issued || !pointed}
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
  } else if (status?.status === "awaiting-dns") {
    body = (
      <>
        <p className="text-sm">
          The cloud is ready to answer on <span className="font-mono">{domain}</span>, but the
          domain does not point at the cloud yet, so links keep the cloud's cloudfront.net address.
          Add this record at your DNS provider, then press "Check now".
        </p>
        <RecordLine name={domain} type="CNAME" value={status.aliasTarget} />
        {check && (
          <p className="text-sm" role="status">
            {cnameReport}
            {pointed && ' Press "Finish" to make it the cloud\'s address.'}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={() => void checkNow()}>
            Check now
          </Button>
          <Button
            className={ACTION_OCCASIONAL}
            disabled={busy || !pointed}
            onClick={() => void act(async () => {})}
          >
            Finish
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setConfirmRemove(true)}>
            Remove
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
                {cnameReport}
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

      <Dialog open={confirmSetUp !== null} onOpenChange={(open) => !open && setConfirmSetUp(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Set up {confirmSetUp?.domain}</DialogTitle>
          </DialogHeader>
          {confirmSetUp?.zone ? (
            <div className="flex flex-col gap-2 text-sm text-muted-foreground">
              <p>
                The domain's DNS lives in the Route53 zone {confirmSetUp.zone} in this AWS account.
                The cloud update requests a certificate for {confirmSetUp.domain} and adds two
                records to that zone:
              </p>
              <ul className="flex flex-col gap-1">
                <li>
                  <span className="font-mono break-all text-foreground">
                    A {confirmSetUp.domain}
                  </span>{" "}
                  points the domain at the cloud.
                </li>
                <li>
                  <span className="font-mono break-all text-foreground">
                    CNAME _&lt;code&gt;.{confirmSetUp.domain}
                  </span>{" "}
                  proves ownership to the certificate authority.
                </li>
              </ul>
              <p>
                The update changes no other record, and stops if {confirmSetUp.domain} already has
                an A, AAAA or CNAME record. Removing the domain later deletes the A record. The
                CNAME record stays until another domain replaces the certificate or the cloud is
                removed.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2 text-sm text-muted-foreground">
              <p>
                The DNS of {confirmSetUp?.domain} lives outside this AWS account. You add its
                records at your DNS provider, in these steps:
              </p>
              <ol className="flex list-decimal flex-col gap-1 pl-5">
                <li>
                  "Set up" runs a cloud update that requests a certificate for{" "}
                  {confirmSetUp?.domain}. The update changes no DNS records.
                </li>
                <li>
                  This section then shows two records to add at your DNS provider. One proves you
                  own the domain, and the other points the domain at the cloud. The first record
                  exists only once the certificate is requested.
                </li>
                <li>
                  "Check now" confirms that the certificate is issued and the domain resolves.
                </li>
                <li>
                  "Finish" runs a second cloud update, which attaches the domain. Links then use{" "}
                  {confirmSetUp?.domain}.
                </li>
              </ol>
              <p>The cloud's cloudfront.net address keeps working throughout.</p>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmSetUp(null)}>
              Cancel
            </Button>
            <Button
              className={ACTION_OCCASIONAL}
              onClick={() => {
                const domain = confirmSetUp?.domain;
                setConfirmSetUp(null);
                if (domain) void act(() => saveDomain(domain));
              }}
            >
              Set up
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* The last install recorded the domain's mode, so the dialog names the
          exact changes. */}
      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove {domain}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2 text-sm text-muted-foreground">
            {status?.status === "active" ? (
              <p>
                The cloud stops answering on {domain}, and every link sent with {domain} stops
                working. Links on the cloud's cloudfront.net address keep working.
              </p>
            ) : (
              <p>Links never used {domain}, so no link stops working.</p>
            )}
            {status?.status === "pending-validation" ? (
              <>
                <p>
                  The cloud update deletes the certificate requested for {domain}, which the cloud
                  never used, and changes no DNS records. Afterwards, delete these records at your
                  DNS provider if you added them:
                </p>
                <ul className="flex flex-col gap-1 font-mono break-all text-foreground">
                  {status.validationRecord && <li>CNAME {status.validationRecord.name}</li>}
                  <li>CNAME {domain}</li>
                </ul>
              </>
            ) : status?.mode === "route53" ? (
              <p>
                The cloud update deletes the A record at {domain} from the domain's Route53 zone in
                this AWS account. The CNAME record at _&lt;code&gt;.{domain} stays, so the
                certificate keeps renewing. The update changes no other record.
              </p>
            ) : (
              <>
                <p>
                  The cloud update changes no DNS records. Afterwards, delete this record at your
                  DNS provider:
                </p>
                <ul className="flex flex-col gap-1 font-mono break-all text-foreground">
                  <li>CNAME {domain}</li>
                </ul>
                {status?.validationRecord && (
                  <p>
                    Keep the record{" "}
                    <span className="font-mono break-all text-foreground">
                      CNAME {status.validationRecord.name}
                    </span>
                    , so the certificate keeps renewing.
                  </p>
                )}
              </>
            )}
            {status?.status !== "pending-validation" && (
              <p>
                The domain's certificate stays on the cloud, unused and at no cost. Setting up{" "}
                {domain} again reuses it. Setting up another domain, or removing the cloud, deletes
                it.
              </p>
            )}
          </div>
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
        <DialogContent className="sm:max-w-3xl">
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
