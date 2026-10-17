/**
 * Pairing a phone so it may sync, and revoking one.
 *
 * ## Why this lives in the admin console
 *
 * Pairing is a phone's install step. Installing a cloud or local app happens
 * here, where the operator approves the app and the console mints its
 * credential, and a phone works the same way: the operator approves it once and
 * it then syncs with nothing more to do. Nothing in the cloud's request path
 * mints a credential, and pairing keeps it that way.
 *
 * ## How the credential reaches the phone
 *
 * This page makes the phone's keypair (`lib/device-pairing.ts`), registers the
 * public half through the server route, and shows the private half once as a
 * QR code for the phone to scan. The private half never reaches admin-web's
 * server. While the code is on screen it is a bearer credential — anyone who
 * photographs it can sync as Starkeep Drive until the device is revoked — so it
 * appears only after "Pair a phone" and disappears on "Done".
 *
 * ## The list
 *
 * The list is the device records themselves, read from SSM through Manager, so
 * a phone paired from any machine can be revoked from this one. A lost phone is
 * the case it exists for.
 */

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
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
import { operatorSession } from "@/lib/operator-session";
import { generateDeviceKeys, pairingPayload } from "@/lib/device-pairing";

/** Must match the route's `MAX_LABEL_LENGTH`. */
const MAX_LABEL_LENGTH = 100;

export interface PairedDevice {
  readonly deviceId: string;
  readonly label: string | null;
  readonly kind: "phone" | "desktop";
  readonly userId: string | null;
  readonly appIds: readonly string[];
  readonly pairedAt: string;
}

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; devices: readonly PairedDevice[] }
  | { kind: "error"; message: string };

type Status =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "showing-code"; deviceId: string; label: string | null; qrDataUrl: string }
  | { kind: "revoked"; deviceId: string }
  | { kind: "error"; message: string };

/** The name a person reads for a device. */
export function deviceName(device: Pick<PairedDevice, "label">): string {
  return device.label ?? "Unnamed device";
}

export function PairedDevicesSection() {
  const [label, setLabel] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [list, setList] = useState<ListState>({ kind: "loading" });
  /** The device whose "Revoke" was pressed once and now asks to be confirmed. */
  const [confirming, setConfirming] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      const { credentials, stackPrefix, region } = await operatorSession();
      const res = await fetch("/api/devices/list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials, stackPrefix, region }),
      });
      const body = (await res.json()) as { devices?: PairedDevice[]; error?: string };
      if (!res.ok || !body.devices) throw new Error(body.error ?? `Request failed (${res.status})`);
      setList({ kind: "ready", devices: body.devices });
    } catch (err) {
      setList({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  async function pair() {
    const name = label.trim() || null;
    if (name !== null && name.length > MAX_LABEL_LENGTH) {
      setStatus({ kind: "error", message: `A label can be at most ${MAX_LABEL_LENGTH} characters.` });
      return;
    }
    setStatus({ kind: "working" });
    try {
      const keys = await generateDeviceKeys();
      const { credentials, stackPrefix, region, userSub } = await operatorSession();
      const res = await fetch("/api/devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          credentials,
          stackPrefix,
          region,
          deviceId: keys.deviceId,
          // The public half only. The private half goes into the QR code below
          // and nowhere else.
          publicKeySpki: keys.publicKeySpki,
          label: name,
          // The signed-in operator. The broker binds the device's data to
          // this user.
          userId: userSub,
        }),
      });
      const body = (await res.json()) as { error?: string; baseUrl?: string };
      if (!res.ok || !body.baseUrl) throw new Error(body.error ?? `Request failed (${res.status})`);

      const qrDataUrl = await QRCode.toDataURL(
        pairingPayload({ keys, baseUrl: body.baseUrl, label: name }),
        { errorCorrectionLevel: "M", margin: 2, width: 288 },
      );
      setStatus({ kind: "showing-code", deviceId: keys.deviceId, label: name, qrDataUrl });
      setLabel("");
      void loadList();
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      void loadList();
    }
  }

  async function revoke(device: PairedDevice) {
    setConfirming(null);
    setStatus({ kind: "working" });
    try {
      const { credentials, stackPrefix, region } = await operatorSession();
      const res = await fetch("/api/devices", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials, stackPrefix, region, deviceId: device.deviceId }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setStatus({ kind: "revoked", deviceId: deviceName(device) });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
    void loadList();
  }

  const busy = status.kind === "working";

  return (
    <Collapsible className="rounded-lg border p-4">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 text-left">
        <h3 className="font-medium">Paired phones</h3>
        <Badge variant="outline" className="text-xs">Experimental</Badge>
        <ChevronDownIcon className="ml-auto size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>

      <CollapsibleContent className="space-y-4 pt-4">
        <p className="text-muted-foreground text-sm">
          Pairing gives a phone its own key, which lets it back up to your cloud through Starkeep
          Drive and nothing else. Name the phone, then scan the code with Starkeep on the phone
          under Connect this device.
        </p>

        {status.kind === "showing-code" ? (
          <div className="flex flex-col items-start gap-3">
            <img
              src={status.qrDataUrl}
              alt={`Pairing code for ${deviceName(status)}`}
              width={288}
              height={288}
              className="rounded-md border bg-white"
            />
            <p className="text-sm">
              Scan this with the phone now. Anyone who photographs this code can sync as this
              phone until you revoke it, so close it once the phone says it is connected.
            </p>
            <Button onClick={() => setStatus({ kind: "idle" })}>Done</Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <Input
              placeholder="Name this phone, e.g. 'Pixel 8'"
              value={label}
              maxLength={MAX_LABEL_LENGTH}
              onChange={(e) => setLabel(e.target.value)}
              disabled={busy}
            />
            <Button onClick={() => void pair()} disabled={busy}>
              {busy ? "Working…" : "Pair a phone"}
            </Button>
          </div>
        )}

        {status.kind === "revoked" ? (
          <Alert>
            <AlertTitle>Revoked {status.deviceId}</AlertTitle>
            <AlertDescription>
              The phone stops being able to sync within five minutes. No other device or app is
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

        <DeviceList
          list={list}
          busy={busy}
          confirming={confirming}
          onAskRevoke={setConfirming}
          onRevoke={(device) => void revoke(device)}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

function DeviceList({
  list,
  busy,
  confirming,
  onAskRevoke,
  onRevoke,
}: {
  list: ListState;
  busy: boolean;
  confirming: string | null;
  onAskRevoke: (deviceId: string | null) => void;
  onRevoke: (device: PairedDevice) => void;
}) {
  if (list.kind === "loading") {
    return <p className="text-muted-foreground text-sm">Loading paired phones…</p>;
  }
  if (list.kind === "error") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load paired phones</AlertTitle>
        <AlertDescription>{list.message}</AlertDescription>
      </Alert>
    );
  }
  if (list.devices.length === 0) {
    return <p className="text-muted-foreground text-sm">No phones are paired.</p>;
  }
  return (
    <ul className="divide-y rounded-md border" aria-label="Paired phones">
      {list.devices.map((device) => (
        <li key={device.deviceId} className="flex items-center gap-3 p-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{deviceName(device)}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">
              {device.deviceId} · paired {new Date(device.pairedAt).toLocaleDateString()}
            </p>
          </div>
          {confirming === device.deviceId ? (
            <>
              <Button variant="destructive" size="sm" onClick={() => onRevoke(device)} disabled={busy}>
                Confirm revoke
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onAskRevoke(null)} disabled={busy}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => onAskRevoke(device.deviceId)} disabled={busy}>
              Revoke
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
