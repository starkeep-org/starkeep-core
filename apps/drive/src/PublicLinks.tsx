/**
 * Public links in Drive: the "Share link…" dialog for one file, and the Links
 * view that lists Drive's links.
 *
 * A Drive link is the platform's direct link: anyone holding it gets the file
 * itself, with no page around it. For a photo or a video the person chooses
 * the largest stand-in (the default) or the original. The platform checks
 * every rule again on each call; what this adds is saying each consequence
 * before the person makes the link:
 *
 * - an original carries whatever metadata its format holds, such as a photo's
 *   location and camera details;
 * - an archived original cannot be shared as itself;
 * - every download of a large file counts against the cloud's transfer
 *   allowance, so a file or an original above 100 MB asks first.
 */

import { useState } from "react";

/** The fields of a library row the dialog and the Links view read. */
export interface ShareableRecord {
  id: string;
  category?: string;
  size_bytes?: number | null;
  original_filename?: string | null;
  sync_status: "local-only" | "synced" | "modified-locally" | "cloud-only";
  cloud_availability?: CloudAvailability | null;
}

export type CloudAvailability = "instant" | "restoring" | "archived" | "absent" | "awaiting-upload";

export interface PublicLink {
  id: string;
  recordId: string | null;
  serves: "stand-in" | "original";
  title: string;
  /** The direct link, or null on a machine that does not know the cloud's address. */
  url: string | null;
  createdAtMs: number;
  expiresAtMs: number | null;
}

/** What `GET /api/public-links` answers. */
export type PublicLinksState =
  | { available: true; mayPublish: boolean; links: PublicLink[] }
  | { available: false; reason: string };

/** Above this, sharing a file or an original asks first. */
export const LARGE_SHARE_BYTES = 100 * 1024 * 1024;

const LIFETIMES: Array<[string, string]> = [
  ["1d", "1 day"],
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["1y", "1 year"],
  ["never", "Never expires"],
];

export const SWITCH_OFF_TEXT =
  "Drive cannot create public links. Turn on “Enable sharing” on the Drive card in admin-web.";

function isMedia(record: ShareableRecord): boolean {
  return record.category === "image" || record.category === "video";
}

function isArchived(record: ShareableRecord): boolean {
  return record.cloud_availability === "archived" || record.cloud_availability === "restoring";
}

/** Why a row cannot be shared yet, or null when it can. */
export function shareBlockedReason(record: ShareableRecord): string | null {
  if (record.sync_status === "synced" || record.sync_status === "cloud-only") return null;
  if (record.sync_status === "modified-locally") {
    return "This file has changes that are not in the cloud yet.";
  }
  return "This file is not in the cloud yet.";
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function expiryText(expiresAtMs: number | null, nowMs: number): string {
  if (expiresAtMs === null) return "Never expires";
  if (expiresAtMs <= nowMs) return "Expired";
  return `Expires ${new Date(expiresAtMs).toLocaleDateString(undefined, { dateStyle: "medium" })}`;
}

async function send(method: string, path: string, body?: unknown): Promise<{ link?: PublicLink }> {
  const res = await fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const parsed = (await res.json().catch(() => ({}))) as { error?: string; link?: PublicLink };
  if (!res.ok) throw new Error(parsed.error ?? `Request failed: ${res.status}`);
  return parsed;
}

function CopyButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="row-action"
      onClick={() => {
        void navigator.clipboard?.writeText(url).then(() => setCopied(true));
      }}
    >
      {copied ? "Copied" : "Copy link"}
    </button>
  );
}

/** The dialog that makes one file's public link. */
export function ShareLinkDialog({
  record,
  mayPublish,
  onClose,
  onCreated,
}: {
  record: ShareableRecord;
  mayPublish: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const media = isMedia(record);
  const archived = isArchived(record);
  const [title, setTitle] = useState(record.original_filename ?? "");
  const [lifetime, setLifetime] = useState("30d");
  const [serves, setServes] = useState<"stand-in" | "original">("stand-in");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<PublicLink | null>(null);

  const sharesOriginal = !media || serves === "original";

  const create = async () => {
    const size = record.size_bytes ?? 0;
    if (sharesOriginal && size > LARGE_SHARE_BYTES) {
      const ok = window.confirm(
        `This file is ${formatMegabytes(size)}. Every download of this file counts against your cloud's transfer allowance. Share it anyway?`,
      );
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      const { link } = await send("POST", "/api/public-links", {
        recordId: record.id,
        serves: media ? serves : "original",
        title: title.trim(),
        lifetime,
      });
      setMade(link ?? null);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Share link">
        <h2>Share link</h2>
        {made ? (
          <>
            <p>Anyone with this link can open the file.</p>
            {made.url ? (
              <div className="link-row">
                <input readOnly value={made.url} aria-label="Public link" />
                <CopyButton url={made.url} />
              </div>
            ) : (
              <p className="muted">This computer does not know the cloud&apos;s address.</p>
            )}
            <div className="dialog-actions">
              <button className="row-action" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            {!mayPublish && <div className="notice warn">{SWITCH_OFF_TEXT}</div>}
            <label className="field">
              <span>Title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
            </label>
            <label className="field">
              <span>Link expires</span>
              <select value={lifetime} onChange={(e) => setLifetime(e.target.value)}>
                {LIFETIMES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {media ? (
              <fieldset className="field">
                <legend>Share</legend>
                <label className="choice">
                  <input
                    type="radio"
                    name="serves"
                    checked={serves === "stand-in"}
                    onChange={() => setServes("stand-in")}
                  />
                  <span>
                    Largest stand-in
                    <small>
                      Anyone with the link can see this at display size, with no location or camera
                      details.
                    </small>
                  </span>
                </label>
                <label className="choice">
                  <input
                    type="radio"
                    name="serves"
                    checked={serves === "original"}
                    disabled={archived}
                    onChange={() => setServes("original")}
                  />
                  <span>
                    Original
                    <small>
                      {archived
                        ? "This original is archived, so it cannot be shared as itself."
                        : "Anyone with the link can download the original, including its location and camera details."}
                    </small>
                  </span>
                </label>
              </fieldset>
            ) : (
              <p className="muted">
                Anyone with the link can download this file, including any metadata inside it.
              </p>
            )}
            {error && <div className="notice error">{error}</div>}
            <div className="dialog-actions">
              <button className="row-action" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                className="row-action primary"
                onClick={() => void create()}
                disabled={busy || !mayPublish || title.trim().length === 0}
              >
                {busy ? "Creating…" : "Create link"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Drive's public links, each with its file, its expiry, and the ways to
 * change or stop it. Listing and stopping work with the switch off, so links
 * made before the switch went off can still be cleaned up.
 */
export function LinksView({
  state,
  records,
  onChanged,
}: {
  state: PublicLinksState | null;
  records: readonly ShareableRecord[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (state === null) return <div className="notice">Loading…</div>;
  if (!state.available) {
    return <div className="notice warn">Public links are unavailable: {state.reason}</div>;
  }

  const names = new Map(records.map((r) => [r.id, r.original_filename ?? r.id]));
  const act = async (id: string, method: string, body?: unknown) => {
    setBusy(id);
    setError(null);
    try {
      await send(method, `/api/public-links/${encodeURIComponent(id)}`, body);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const now = Date.now();
  return (
    <>
      {!state.mayPublish && <div className="notice warn">{SWITCH_OFF_TEXT}</div>}
      {error && <div className="notice error">{error}</div>}
      {state.links.length === 0 ? (
        <div className="notice">No public links. Use “Share link…” on a file to make one.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>File</th>
              <th>Shares</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {state.links.map((link) => (
              <tr key={link.id}>
                <td title={link.title}>{link.title}</td>
                <td>{link.recordId ? (names.get(link.recordId) ?? "—") : "—"}</td>
                <td>{link.serves === "original" ? "Original" : "Stand-in"}</td>
                <td>
                  {state.mayPublish ? (
                    <select
                      aria-label={`Lifetime of ${link.title}`}
                      value=""
                      disabled={busy !== null}
                      onChange={(e) => void act(link.id, "PATCH", { lifetime: e.target.value })}
                    >
                      <option value="" disabled>
                        {expiryText(link.expiresAtMs, now)}
                      </option>
                      {LIFETIMES.map(([value, label]) => (
                        <option key={value} value={value}>
                          {value === "never" ? label : `${label} from now`}
                        </option>
                      ))}
                    </select>
                  ) : (
                    expiryText(link.expiresAtMs, now)
                  )}
                </td>
                <td className="actions">
                  {link.url && <CopyButton url={link.url} />}
                  {state.mayPublish && (
                    <button
                      className="row-action"
                      disabled={busy !== null}
                      onClick={() => {
                        if (window.confirm("Replace this link? The old link stops working.")) {
                          void act(link.id, "PATCH", { rotateLink: true });
                        }
                      }}
                    >
                      Replace link
                    </button>
                  )}
                  <button
                    className="row-action"
                    disabled={busy !== null}
                    onClick={() => {
                      if (window.confirm(`Stop sharing "${link.title}"?`)) {
                        void act(link.id, "DELETE");
                      }
                    }}
                  >
                    Stop sharing
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
