import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Stand-ins on this machine: the sync-down ceilings, "Keep originals here",
 * the backlog, and "Free up space".
 *
 * Photographs, videos and audio are the platform's stand-in categories. This
 * node receives every stand-in up to its ceiling, and every self-canonical
 * original up to it, for the whole library; anything larger arrives only when
 * something asks for it. Every other file arrives on every node. Nothing
 * removes a file automatically — "Free up space" is the one path, and it
 * proves cloud copies first.
 */

type Category = "image" | "video" | "audio";
type Ceilings = Record<Category, number | null>;
type NodeKind = "phone" | "desktop";

interface BacklogCount {
  count: number;
  complete: boolean;
}

interface StandInsResponse {
  nodeKind: NodeKind;
  ceilings: Ceilings;
  configured: Partial<Ceilings>;
  defaults: Record<NodeKind, Ceilings>;
  standardSizes: Record<Category, number[]>;
  canonicalThresholds: Record<Category, number>;
  heldBytes: Record<Category, { originals: number; standIns: number }>;
  keepOriginals: boolean;
  /** Every original in the library, per category, whether or not it is here. */
  libraryOriginals: Record<Category, { count: number; bytes: number }>;
  backlog: Record<"missing-canonical" | "missing-fidelity", BacklogCount>;
  offline?: boolean;
  error?: string;
}

type Scope = "originals" | "originals-and-above-ceiling";

interface FreeUpSpaceItem {
  recordId: string;
  sizeBytes: number;
  kind: "original" | "stand-in";
}

interface FreeUpSpaceReport {
  requestedBytes: number;
  freedBytes: number;
  removed: FreeUpSpaceItem[];
  refused: Array<FreeUpSpaceItem & { reason: string; detail: string }>;
  eligibleBytes: number;
  dryRun: boolean;
  cloudReachable: boolean;
  error?: string;
}

const CATEGORIES: readonly Category[] = ["image", "video", "audio"];

const CATEGORY_LABELS: Record<Category, string> = {
  image: "Photos",
  video: "Videos",
  audio: "Audio",
};

/** What a ceiling's number measures, per category. */
const FIDELITY_UNITS: Record<Category, string> = {
  image: "px",
  video: "px",
  audio: "kbps",
};

const GIB = 1024 ** 3;

/** Binary units, matching the operator's OS. */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${Number.isInteger(value) || value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function formatCount(backlog: BacklogCount): string {
  return `${backlog.complete ? "" : "at least "}${backlog.count.toLocaleString()}`;
}

/**
 * The ceilings to offer: the standard sizes and the canonical threshold, plus
 * the saved value when a hand-edited config holds some other number — so the
 * select shows what is in force rather than a blank.
 */
function choicesFor(standard: readonly number[], canonical: number, current: number | null): number[] {
  const sizes = new Set([...standard, canonical]);
  if (current !== null) sizes.add(current);
  return [...sizes].sort((a, b) => a - b);
}

/** The option value a ceiling is stored under in a `<select>`. */
function ceilingValue(ceiling: number | null): string {
  return ceiling === null ? "none" : String(ceiling);
}

export function StandInsSection() {
  const [state, setState] = useState<StandInsResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "offline" | "saving" | "saved">(
    "loading",
  );
  const [nodeKind, setNodeKind] = useState<NodeKind>("desktop");
  const [ceilings, setCeilings] = useState<Ceilings | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/residency/stand-ins")
      .then((r) => r.json())
      .then((body: StandInsResponse) => {
        if (cancelled) return;
        if (body.offline || !body.ceilings) {
          setStatus("offline");
          return;
        }
        setState(body);
        setNodeKind(body.nodeKind);
        setCeilings(body.ceilings);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("offline");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty =
    state !== null &&
    ceilings !== null &&
    (nodeKind !== state.nodeKind ||
      CATEGORIES.some((c) => ceilings[c] !== state.ceilings[c]));

  const changeKind = useCallback(
    (kind: NodeKind) => {
      setNodeKind(kind);
      // A different kind of node starts from that kind's defaults. The
      // operator edits from there rather than from the other kind's numbers.
      if (state) setCeilings({ ...state.defaults[kind] });
      setStatus("ready");
    },
    [state],
  );

  const save = useCallback(async () => {
    if (!ceilings) return;
    setStatus("saving");
    const res = await fetch("/api/residency/stand-ins", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeKind, ceilings }),
    });
    const body = (await res.json()) as { problems?: string[]; error?: string };
    if (!res.ok) {
      setProblems(body.problems ?? [body.error ?? "Save failed"]);
      setStatus("ready");
      return;
    }
    setProblems([]);
    setState((current) => (current ? { ...current, nodeKind, ceilings } : current));
    setStatus("saved");
  }, [ceilings, nodeKind]);

  if (status === "loading") {
    return <p className="text-sm text-muted-foreground">Reading this machine&apos;s ceilings…</p>;
  }
  if (status === "offline" || !state || !ceilings) {
    return (
      <p className="text-sm text-muted-foreground">
        The local data server isn&apos;t running, so there are no ceilings to show yet.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h3 className="text-sm font-medium">Sync-down ceilings</h3>
        <p className="text-sm text-muted-foreground">
          This machine receives every size up to its ceiling for the whole library. Larger sizes
          and originals above the ceiling arrive only when something opens them.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">This machine is a</span>
          <select
            aria-label="Kind of node"
            className="rounded border bg-transparent px-2 py-1 text-xs"
            value={nodeKind}
            onChange={(e) => changeKind(e.target.value as NodeKind)}
          >
            <option value="desktop">desktop</option>
            <option value="phone">phone</option>
          </select>
        </label>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-2 pr-4 font-medium">Category</th>
              <th className="py-2 pr-4 font-medium">Ceiling</th>
              <th className="py-2 pr-4 font-medium text-right">Originals here</th>
              <th className="py-2 font-medium text-right">Stand-ins here</th>
            </tr>
          </thead>
          <tbody>
            {CATEGORIES.map((category) => {
              const unit = FIDELITY_UNITS[category];
              const canonical = state.canonicalThresholds[category];
              const held = state.heldBytes[category];
              return (
                <tr key={category} className="border-b last:border-0">
                  <td className="py-2 pr-4">{CATEGORY_LABELS[category]}</td>
                  <td className="py-2 pr-4">
                    <select
                      aria-label={`Ceiling for ${CATEGORY_LABELS[category]}`}
                      className="rounded border bg-transparent px-2 py-1 text-xs"
                      value={ceilingValue(ceilings[category])}
                      onChange={(e) => {
                        const value = e.target.value === "none" ? null : Number(e.target.value);
                        setCeilings({ ...ceilings, [category]: value });
                        setStatus("ready");
                      }}
                    >
                      <option value="none">none — on demand only</option>
                      {choicesFor(state.standardSizes[category], canonical, ceilings[category]).map(
                        (size) => (
                          <option key={size} value={String(size)}>
                            {size} {unit}
                            {size === canonical ? " (canonical)" : ""}
                          </option>
                        ),
                      )}
                    </select>
                    {ceilings[category] === state.defaults[nodeKind][category] && (
                      <span className="ml-2 text-xs text-muted-foreground">default</span>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">
                    {formatBytes(held.originals)}
                  </td>
                  <td className="py-2 text-right tabular-nums text-muted-foreground">
                    {formatBytes(held.standIns)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {problems.length > 0 && (
          <ul className="text-sm text-destructive">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={!dirty || status === "saving"} onClick={() => void save()}>
            {status === "saving" ? "Saving…" : "Save ceilings"}
          </Button>
          {status === "saved" && (
            <span className="text-xs text-muted-foreground">
              Saved. The data server restarts to apply them.
            </span>
          )}
        </div>
      </section>

      <KeepOriginals
        initial={state.keepOriginals}
        toDownload={CATEGORIES.reduce(
          (sum, c) =>
            sum + Math.max(0, state.libraryOriginals[c].bytes - state.heldBytes[c].originals),
          0,
        )}
      />

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Backlog</h3>
        <p className="text-sm text-muted-foreground">
          Originals waiting on an app. Until an app makes the canonical stand-in, an original
          stays out of deep archive, so its storage cost does not drop.
        </p>
        <ul className="text-sm">
          <li>
            <span className="tabular-nums">{formatCount(state.backlog["missing-canonical"])}</span>{" "}
            waiting for a canonical stand-in
          </li>
          <li>
            <span className="tabular-nums">{formatCount(state.backlog["missing-fidelity"])}</span>{" "}
            with no reported fidelity
          </li>
        </ul>
      </section>

      <FreeUpSpace />
    </div>
  );
}

/**
 * "Keep originals here": this machine receives every original, as a backup
 * machine would, and "Free up space" leaves them. The estimate is the
 * library's originals less what this machine already holds, so the person sees
 * roughly what turning it on downloads before saving.
 */
function KeepOriginals({ initial, toDownload }: { initial: boolean; toDownload: number }) {
  const [saved, setSaved] = useState(initial);
  const [keep, setKeep] = useState(initial);
  const [status, setStatus] = useState<"ready" | "saving" | "saved">("ready");
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch("/api/residency/stand-ins", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keepOriginals: keep }),
      });
      const body = (await res.json()) as { problems?: string[]; error?: string };
      if (!res.ok) {
        setError((body.problems ?? [body.error ?? "Save failed"]).join(" "));
        setStatus("ready");
        return;
      }
      setSaved(keep);
      setStatus("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("ready");
    }
  }, [keep]);

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">Keep originals here</h3>
      <p className="text-sm text-muted-foreground">
        Turn this on for a machine that should hold every original, such as a backup machine.
        This machine then receives every original, and &quot;Free up space&quot; leaves them.
        Larger stand-ins still follow the ceilings.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={keep}
          onChange={(e) => {
            setKeep(e.target.checked);
            setStatus("ready");
          }}
        />
        <span>Keep every original on this machine</span>
      </label>
      {keep && !saved && (
        <p className="text-sm" role="status">
          About {formatBytes(toDownload)} of originals to download.
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={keep === saved || status === "saving"} onClick={() => void save()}>
          {status === "saving" ? "Saving…" : "Save"}
        </Button>
        {status === "saved" && (
          <span className="text-xs text-muted-foreground">
            Saved. The data server restarts to apply it.
          </span>
        )}
      </div>
    </section>
  );
}

/**
 * "Free up space": an estimate first, then the removal.
 *
 * The estimate is a dry run of the same pass, so what the person confirms is
 * what the daemon proved rather than a guess made here. The removal runs only
 * from an estimate, and a changed amount or scope asks for a fresh one.
 */
function FreeUpSpace() {
  const [gib, setGib] = useState("10");
  const [scope, setScope] = useState<Scope>("originals");
  const [estimate, setEstimate] = useState<FreeUpSpaceReport | null>(null);
  const [result, setResult] = useState<FreeUpSpaceReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bytes = Math.round(Number(gib) * GIB);
  const valid = Number.isFinite(bytes) && bytes > 0;

  const run = useCallback(
    async (dryRun: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/residency/free-up-space", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bytes, scope, dryRun }),
        });
        const body = (await res.json()) as FreeUpSpaceReport;
        if (!res.ok) {
          setError(body.error ?? `The data server answered ${res.status}`);
          return;
        }
        if (dryRun) {
          setEstimate(body);
          setResult(null);
        } else {
          setResult(body);
          setEstimate(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [bytes, scope],
  );

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">Free up space</h3>
      <p className="text-sm text-muted-foreground">
        Removes files from this machine, largest first, only after proving the cloud holds the
        file, its original and the original&apos;s canonical stand-in. Nothing else removes a photo,
        video or audio file.
      </p>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Free</span>
          <input
            aria-label="GiB to free"
            type="number"
            min={0}
            step="1"
            value={gib}
            className="w-20 rounded border bg-transparent px-2 py-1 text-right text-xs"
            onChange={(e) => {
              setGib(e.target.value);
              setEstimate(null);
            }}
          />
          <span className="text-muted-foreground">GiB from</span>
        </label>
        <select
          aria-label="What to remove"
          className="rounded border bg-transparent px-2 py-1 text-xs"
          value={scope}
          onChange={(e) => {
            setScope(e.target.value as Scope);
            setEstimate(null);
          }}
        >
          <option value="originals">originals</option>
          <option value="originals-and-above-ceiling">originals and sizes above the ceiling</option>
        </select>
        <Button size="sm" variant="outline" disabled={!valid || busy} onClick={() => void run(true)}>
          Estimate
        </Button>
        <Button size="sm" disabled={!estimate || busy} onClick={() => void run(false)}>
          Free up space
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {estimate && <ReportLine report={estimate} />}
      {result && <ReportLine report={result} />}
    </section>
  );
}

function ReportLine({ report }: { report: FreeUpSpaceReport }) {
  if (!report.cloudReachable) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        This machine is not connected to a cloud, so nothing can be shown to be safe to remove.
      </p>
    );
  }
  const verb = report.dryRun ? "Would free" : "Freed";
  return (
    <p className="text-sm" role="status">
      {verb} {formatBytes(report.freedBytes)} from {report.removed.length} file(s) of{" "}
      {formatBytes(report.eligibleBytes)} eligible.
      {report.refused.length > 0 &&
        ` Kept ${report.refused.length} that the cloud could not yet be shown to hold.`}
    </p>
  );
}
