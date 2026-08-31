"use client";

/**
 * Pairing a handset so it may sync.
 *
 * ## Why this lives in the admin console
 *
 * Registration is the one step a device cannot authenticate for itself: an
 * unpaired phone has no credential to present. The alternative was to let it
 * enrol with its Cognito token, which would mean teaching the data plane to
 * verify end-user JWTs — and that plane identifies *apps*, not users, by
 * deliberate design. Reversing it belongs to the multi-user work, not to
 * getting a phone syncing.
 *
 * So the operator does it here, with credentials they already hold. It is also
 * the stronger bar: pairing requires this console rather than a password.
 *
 * ## The values are typed in, for now
 *
 * The phone shows its device id and public key; they get copied across by hand.
 * That is clumsy and it is temporary — a QR flow was investigated and deferred
 * (`photos-mobile/mobile-sync-design.md` §4.4), because the direction that is
 * actually pleasant, admin-shows/phone-scans, needs a new unauthenticated cloud
 * route and a bearer token. Worth doing deliberately, not as a detail of
 * getting sync working.
 *
 * ## Nothing secret is handled here
 *
 * The public half of a device key is not a credential. What makes this
 * privileged is *writing* it — that is what tells the cloud whose signatures to
 * trust, and it is why this uses the operator's AWS session rather than
 * anything the phone could present.
 */

import { useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  readCloudConfig,
  readCognitoSession,
  writeCloudCredentials,
  writeCognitoSession,
} from "@/lib/cloud-config";
import {
  refreshTokens,
  getIdentityPoolCredentials,
  type STSCredentials,
} from "@/lib/cognito-auth";

/** Must match the handler's `isValidDeviceId` — this becomes a parameter name. */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** A 32-byte Ed25519 key in its 44-byte SPKI wrapper is always 60 base64 chars. */
const SPKI_RE = /^[A-Za-z0-9+/]{59}=$/;

type Status =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "paired"; deviceId: string }
  | { kind: "revoked"; deviceId: string }
  | { kind: "error"; message: string };

export function PairedDevicesSection() {
  const [deviceId, setDeviceId] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [label, setLabel] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  /**
   * A fresh STS session for this one call.
   *
   * Minted per action rather than held, matching `CloudAppsSection`: the
   * credentials expire, and a stale one surfaces as an opaque AWS error at the
   * moment the operator is trying to do something.
   */
  async function credentialsNow(): Promise<{
    credentials: STSCredentials;
    stackPrefix: string;
    region: string;
  }> {
    const cfg = await readCloudConfig();
    if (!cfg) throw new Error("Cloud is not configured. Complete the cloud setup first.");
    const session = await readCognitoSession();
    if (!session?.refreshToken) throw new Error("Not signed in. Sign in from the dashboard first.");

    const tokens = await refreshTokens(cfg.cognitoConfig, session.refreshToken);
    const credentials = await getIdentityPoolCredentials(cfg.cognitoConfig, tokens.idToken);
    await writeCloudCredentials(credentials);
    await writeCognitoSession({ ...session, refreshToken: tokens.refreshToken });

    return { credentials, stackPrefix: cfg.stackPrefix, region: cfg.region };
  }

  async function submit(method: "POST" | "DELETE") {
    const id = deviceId.trim();
    const key = publicKey.trim();

    // Validated here as well as in the route, because a mistyped key is the
    // likeliest failure of a copy-across flow and the operator is standing
    // right here. The same check in the Lambda would surface as a device that
    // silently cannot sync, visible only in CloudWatch.
    if (!DEVICE_ID_RE.test(id)) {
      setStatus({ kind: "error", message: "Device id must be 1-128 chars of A-Z a-z 0-9 _ -" });
      return;
    }
    if (method === "POST" && !SPKI_RE.test(key)) {
      setStatus({
        kind: "error",
        message: "Public key should be 60 base64 characters ending in '='. Check it copied whole.",
      });
      return;
    }

    setStatus({ kind: "working" });
    try {
      const { credentials, stackPrefix, region } = await credentialsNow();
      const res = await fetch("/api/devices", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          credentials,
          stackPrefix,
          region,
          deviceId: id,
          publicKeySpki: key,
          label: label.trim() || null,
          // Recorded although nothing reads it yet — it is what saves already
          // paired devices a migration when shared data is partitioned per
          // user. The email is the closest stable handle this console has.
          userId: (await readCognitoSession())?.userEmail ?? null,
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);

      setStatus(
        method === "POST" ? { kind: "paired", deviceId: id } : { kind: "revoked", deviceId: id },
      );
      if (method === "POST") setPublicKey("");
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  const busy = status.kind === "working";

  return (
    <Collapsible className="rounded-lg border p-4">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 text-left">
        <h3 className="font-medium">Pair with mobile app</h3>
        <Badge variant="outline" className="text-xs">Experimental</Badge>
        <ChevronDownIcon className="ml-auto size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>

      <CollapsibleContent className="space-y-4 pt-4">
      <p className="text-muted-foreground text-sm">
        A phone signs its sync requests with a key only it holds. Pairing publishes the public
        half so the cloud will accept them — open Starkeep on the handset and copy the two values
        from its Sync section.
      </p>

      <div className="space-y-2">
        <Input
          placeholder="Device id (shown on the phone)"
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
          disabled={busy}
        />
        <Input
          placeholder="Public key (60 characters, ends in =)"
          value={publicKey}
          onChange={(e) => setPublicKey(e.target.value)}
          disabled={busy}
          className="font-mono text-xs"
        />
        <Input
          placeholder="Label — optional, e.g. 'Pixel 5'"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          disabled={busy}
        />
      </div>

      <div className="flex gap-2">
        <Button onClick={() => void submit("POST")} disabled={busy}>
          {busy ? "Working…" : "Pair device"}
        </Button>
        {/* Revoking needs only the id — the key is irrelevant to a delete, and
            requiring it would mean an operator with a lost phone has to go and
            find a value they can no longer read off it. */}
        <Button variant="outline" onClick={() => void submit("DELETE")} disabled={busy}>
          Revoke
        </Button>
      </div>

      {status.kind === "paired" ? (
        <Alert>
          <AlertTitle>Paired {status.deviceId}</AlertTitle>
          <AlertDescription>
            The cloud will accept this device within five minutes — the verifier caches keys for
            that long. Tap Sync now on the phone.
          </AlertDescription>
        </Alert>
      ) : null}

      {status.kind === "revoked" ? (
        <Alert>
          <AlertTitle>Revoked {status.deviceId}</AlertTitle>
          <AlertDescription>
            Its signatures stop being accepted within five minutes. No other device or app is
            affected.
          </AlertDescription>
        </Alert>
      ) : null}

      {status.kind === "error" ? (
        <Alert variant="destructive">
          <AlertTitle>Could not complete</AlertTitle>
          <AlertDescription>{status.message}</AlertDescription>
        </Alert>
      ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
