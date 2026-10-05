import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * "Quality kept when originals archive": the library's canonical thresholds.
 *
 * An original above its threshold archives behind a canonical stand-in at the
 * threshold, which is what the person sees until a paid restore. The value is
 * library-wide — one settings file that syncs to every node — and mostly an
 * upfront choice, so the section also appears once in the install flow of an
 * app that reads photos or videos, before the library holds any.
 *
 * A change applies to originals added from now on. Each existing original
 * keeps the threshold stamped on it, which the save dialog says before saving.
 * Video resolution is advisory: it guides the encoder and changes nothing about
 * which originals archive, so a resolution change saves without the dialog.
 */

export type Category = "image" | "video";

interface AdvisoryLongEdges {
  canonical: number;
  bySize: Record<string, number>;
}

interface CategoryView {
  canonicalThreshold: number;
  standardSizes: number[];
  advisoryLongEdges: AdvisoryLongEdges | null;
}

export interface LibraryStandardsResponse {
  current: Record<Category, CategoryView>;
  defaults: Record<Category, CategoryView>;
  set: boolean;
  problems: string[];
  knowsLibraryValue: boolean;
  ranges: {
    canonicalThreshold: Record<Category, { min: number; max: number }>;
    advisoryLongEdge: { min: number; max: number };
  };
  libraryOriginals: Record<Category, { count: number; bytes: number }>;
  offline?: boolean;
  error?: string;
}

/** The values the person is editing. */
export interface LibraryStandardsDraft {
  image: number;
  video: number;
  videoEdges: AdvisoryLongEdges;
}

export const CATEGORIES: readonly Category[] = ["image", "video"];

const CATEGORY_LABELS: Record<Category, string> = { image: "Photos", video: "Videos" };

const UNITS: Record<Category, string> = { image: "px", video: "kbps" };

/** The thresholds offered before a custom value. */
export const THRESHOLD_CHOICES: Record<Category, readonly number[]> = {
  image: [2560, 3200, 4272, 5120, 6000, 8192],
  video: [3000, 4800, 8000, 12000],
};

/** Video resolutions, named by their usual height and stored as a long edge. */
export const RESOLUTION_CHOICES: ReadonlyArray<{ label: string; longEdge: number }> = [
  { label: "720p", longEdge: 1280 },
  { label: "1080p", longEdge: 1920 },
  { label: "1440p", longEdge: 2560 },
  { label: "2160p", longEdge: 3840 },
];

const CUSTOM = "custom";

export function draftOf(view: Record<Category, CategoryView>): LibraryStandardsDraft {
  return {
    image: view.image.canonicalThreshold,
    video: view.video.canonicalThreshold,
    videoEdges: view.video.advisoryLongEdges ?? { canonical: 1920, bySize: {} },
  };
}

/** The PUT body: the settings file's shape. */
export function settingsBodyOf(draft: LibraryStandardsDraft): unknown {
  return {
    standIns: {
      image: { canonicalThreshold: draft.image },
      video: { canonicalThreshold: draft.video, advisoryLongEdges: draft.videoEdges },
    },
  };
}

/** The categories whose threshold differs between two drafts. */
export function changedThresholds(a: LibraryStandardsDraft, b: LibraryStandardsDraft): Category[] {
  return CATEGORIES.filter((c) => a[c] !== b[c]);
}

function sameEdges(a: AdvisoryLongEdges, b: AdvisoryLongEdges): boolean {
  return a.canonical === b.canonical && JSON.stringify(a.bySize) === JSON.stringify(b.bySize);
}

export function draftsEqual(a: LibraryStandardsDraft, b: LibraryStandardsDraft): boolean {
  return changedThresholds(a, b).length === 0 && sameEdges(a.videoEdges, b.videoEdges);
}

/** Sentences for every value outside its range. Empty when the draft is valid. */
export function draftProblems(
  draft: LibraryStandardsDraft,
  ranges: LibraryStandardsResponse["ranges"],
): string[] {
  const problems: string[] = [];
  for (const c of CATEGORIES) {
    const { min, max } = ranges.canonicalThreshold[c];
    if (!Number.isInteger(draft[c]) || draft[c] < min || draft[c] > max) {
      problems.push(`${CATEGORY_LABELS[c]}: choose a whole number from ${min} to ${max} ${UNITS[c]}.`);
    }
  }
  return problems;
}

/** Binary units, matching the operator's OS. */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${Number.isInteger(value) || value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function resolutionLabel(longEdge: number): string {
  return RESOLUTION_CHOICES.find((r) => r.longEdge === longEdge)?.label ?? `${longEdge} px long edge`;
}

/** One threshold: the offered choices, the saved value, and a custom value. */
function ThresholdSelect({
  category,
  value,
  defaultValue,
  onChange,
}: {
  category: Category;
  value: number;
  defaultValue: number;
  onChange: (value: number) => void;
}) {
  const offered = new Set([...THRESHOLD_CHOICES[category], defaultValue]);
  const [custom, setCustom] = useState(!offered.has(value));
  const choices = [...offered].sort((a, b) => a - b);
  return (
    <span className="inline-flex items-center gap-2">
      <select
        aria-label={`Threshold for ${CATEGORY_LABELS[category]}`}
        className="rounded border bg-transparent px-2 py-1 text-xs"
        value={custom ? CUSTOM : String(value)}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(Number(e.target.value));
        }}
      >
        {choices.map((choice) => (
          <option key={choice} value={String(choice)}>
            {choice} {UNITS[category]}
            {choice === defaultValue ? " (default)" : ""}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {custom && (
        <input
          aria-label={`Custom threshold for ${CATEGORY_LABELS[category]}`}
          type="number"
          step="1"
          className="w-24 rounded border bg-transparent px-2 py-1 text-right text-xs"
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))}
        />
      )}
    </span>
  );
}

function ResolutionSelect({
  label,
  value,
  defaultValue,
  onChange,
}: {
  label: string;
  value: number;
  defaultValue: number;
  onChange: (longEdge: number) => void;
}) {
  const choices = [...new Set([...RESOLUTION_CHOICES.map((r) => r.longEdge), value, defaultValue])].sort(
    (a, b) => a - b,
  );
  return (
    <select
      aria-label={label}
      className="rounded border bg-transparent px-2 py-1 text-xs"
      value={String(value)}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {choices.map((edge) => (
        <option key={edge} value={String(edge)}>
          {resolutionLabel(edge)}
          {edge === defaultValue ? " (default)" : ""}
        </option>
      ))}
    </select>
  );
}

/**
 * The editable fields, for the Storage page and the install flow alike.
 * `categories` narrows the rows to the ones an installing app reads.
 */
export function LibraryStandardsFields({
  state,
  draft,
  onChange,
  categories = CATEGORIES,
}: {
  state: LibraryStandardsResponse;
  draft: LibraryStandardsDraft;
  onChange: (draft: LibraryStandardsDraft) => void;
  categories?: readonly Category[];
}) {
  const defaults = draftOf(state.defaults);
  const smallerSizes = state.current.video.standardSizes;
  return (
    <div className="space-y-4">
      {categories.map((category) => {
        const originals = state.libraryOriginals[category];
        return (
          <div key={category} className="space-y-2">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="w-16 font-medium">{CATEGORY_LABELS[category]}</span>
              <ThresholdSelect
                category={category}
                value={draft[category]}
                defaultValue={defaults[category]}
                onChange={(value) => onChange({ ...draft, [category]: value })}
              />
            </div>
            <p className="text-xs text-muted-foreground" role="note">
              {originals.count === 0
                ? `The library holds no ${CATEGORY_LABELS[category].toLowerCase()} yet.`
                : `The library holds ${originals.count.toLocaleString()} ${CATEGORY_LABELS[category].toLowerCase()}, ${formatBytes(originals.bytes)} of originals.`}
            </p>
            {category === "video" && (
              <div className="flex flex-wrap items-center gap-3 pl-[76px] text-xs text-muted-foreground">
                <label className="flex items-center gap-2">
                  <span>Archived-quality resolution</span>
                  <ResolutionSelect
                    label="Resolution for the canonical video"
                    value={draft.videoEdges.canonical}
                    defaultValue={defaults.videoEdges.canonical}
                    onChange={(edge) =>
                      onChange({ ...draft, videoEdges: { ...draft.videoEdges, canonical: edge } })
                    }
                  />
                </label>
                {smallerSizes.map((size) => (
                  <label key={size} className="flex items-center gap-2">
                    <span>Smaller ({size} kbps) resolution</span>
                    <ResolutionSelect
                      label={`Resolution for the ${size} kbps video`}
                      value={draft.videoEdges.bySize[String(size)] ?? 1280}
                      defaultValue={defaults.videoEdges.bySize[String(size)] ?? 1280}
                      onChange={(edge) =>
                        onChange({
                          ...draft,
                          videoEdges: {
                            ...draft.videoEdges,
                            bySize: { ...draft.videoEdges.bySize, [String(size)]: edge },
                          },
                        })
                      }
                    />
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Save a draft through the daemon. Returns the refusal's sentences, or none. */
export async function saveLibraryStandards(draft: LibraryStandardsDraft): Promise<string[]> {
  const res = await fetch("/api/library/stand-in-standards", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settingsBodyOf(draft)),
  });
  if (res.ok) return [];
  const body = (await res.json().catch(() => ({}))) as { problems?: string[]; error?: string };
  return body.problems ?? [body.error ?? `Save failed (${res.status})`];
}

export function LibraryStandardsSection() {
  const [state, setState] = useState<LibraryStandardsResponse | null>(null);
  const [draft, setDraft] = useState<LibraryStandardsDraft | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "offline" | "saving" | "saved">("loading");
  const [problems, setProblems] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<Category[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/library/stand-in-standards")
      .then((r) => r.json())
      .then((body: LibraryStandardsResponse) => {
        if (cancelled) return;
        if (body.offline || !body.current) {
          setStatus("offline");
          return;
        }
        setState(body);
        setDraft(draftOf(body.current));
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("offline");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async () => {
    if (!draft || !state) return;
    setConfirming(null);
    setStatus("saving");
    const refused = await saveLibraryStandards(draft);
    if (refused.length > 0) {
      setProblems(refused);
      setStatus("ready");
      return;
    }
    setProblems([]);
    setState({ ...state, set: true, current: { ...state.current, ...viewOf(draft, state) } });
    setStatus("saved");
  }, [draft, state]);

  if (status === "loading") {
    return <p className="text-sm text-muted-foreground">Reading the library&apos;s settings…</p>;
  }
  if (status === "offline" || !state || !draft) {
    return (
      <p className="text-sm text-muted-foreground">
        The local data server isn&apos;t running, so the library&apos;s settings can&apos;t be shown yet.
      </p>
    );
  }

  const saved = draftOf(state.current);
  const dirty = !draftsEqual(draft, saved);
  const invalid = draftProblems(draft, state.ranges);

  const requestSave = () => {
    // A threshold change in a category that already holds originals needs the
    // person to know what happens to those originals. Nothing else does.
    const affected = changedThresholds(draft, saved).filter((c) => state.libraryOriginals[c].count > 0);
    if (affected.length > 0) setConfirming(affected);
    else void save();
  };

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">Quality kept when originals archive</h3>
      <p className="text-sm text-muted-foreground">
        An original larger than this archives to deep storage, and a copy at this size stays
        instantly available. A higher value keeps more detail and costs more to store. This
        setting applies to the whole library, on every device.
      </p>
      <LibraryStandardsFields state={state} draft={draft} onChange={(next) => {
        setDraft(next);
        setStatus("ready");
      }} />
      {[...invalid, ...problems].length > 0 && (
        <ul className="text-sm text-destructive">
          {[...invalid, ...problems].map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={!dirty || invalid.length > 0 || status === "saving"}
          onClick={requestSave}
        >
          {status === "saving" ? "Saving…" : "Save"}
        </Button>
        {status === "saved" && (
          <span className="text-xs text-muted-foreground">Saved. Every device picks it up at its next sync.</span>
        )}
      </div>

      <Dialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change the quality kept when originals archive?</DialogTitle>
            <DialogDescription>
              {confirming?.map((c) => CATEGORY_LABELS[c]).join(" and ")} already in the library keep
              their current archived-quality copies. The new value applies to originals added from now
              on.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button onClick={() => void save()}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** The saved draft, as the response's per-category view. */
function viewOf(draft: LibraryStandardsDraft, state: LibraryStandardsResponse): Record<Category, CategoryView> {
  return {
    image: { ...state.current.image, canonicalThreshold: draft.image },
    video: { ...state.current.video, canonicalThreshold: draft.video, advisoryLongEdges: draft.videoEdges },
  };
}
