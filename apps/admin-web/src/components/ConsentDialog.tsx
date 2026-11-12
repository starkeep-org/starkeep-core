/**
 * The install consent dialog: what an app asks for, shown before any install
 * acts on it.
 *
 * Both install paths open it. A local install always does. A cloud install
 * does unless the person already approved the same manifest locally, since
 * the cloud deploys the manifest a local install pinned; a cloud-only install
 * would otherwise act on grants nobody was shown.
 *
 * The quality step belongs to the local install only: it sets the local
 * library's stand-in standards, which a cloud action has no business setting.
 */
import { useEffect, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  publicSharingConsent,
  type AppSurface,
  type LocalAppEntry,
  type ManifestSummary,
} from "@/lib/app-types";
import {
  draftOf,
  draftProblems,
  draftsEqual,
  LibraryStandardsFields,
  saveLibraryStandards,
  type Category,
  type LibraryStandardsDraft,
  type LibraryStandardsResponse,
} from "@/components/LibraryStandardsSection";

/**
 * A grant's file categories, named in the plural for the install prompt.
 *
 * One entry per category an app may be granted, plus `other`. A category
 * missing here shows as its raw id, so `consent-category-names.test.ts` checks
 * the map against the registry's `APP_GRANTABLE_CATEGORIES`.
 */
const CATEGORY_NAMES: Record<string, string> = {
  image: "Images",
  video: "Videos",
  audio: "Audio",
  document: "Documents",
  text: "Text files",
  code: "Code files",
  font: "Fonts",
  archive: "Archives",
  data: "Data files",
  model3d: "3D models",
  example: "Example files",
  other: "Other files",
};

export function categoriesOf(types: readonly string[]): string {
  const prefixes = [...new Set(types.map((t) => t.split("/")[0] ?? t))];
  return prefixes.map((p) => CATEGORY_NAMES[p] ?? p).join(", ");
}

export function ConsentDialog({
  entry,
  surface = "local",
  title,
  onApprove,
  onCancel,
}: {
  entry: LocalAppEntry;
  /** Where the approved install acts. Defaults to the local install. */
  surface?: "local" | AppSurface;
  /** The question the dialog asks. Defaults to "Install <name>?". */
  title?: string;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const grants = entry.manifest.infraRequirements?.fileAccess ?? [];
  const allAccess = entry.manifest.infraRequirements?.fileAccessAll ?? false;
  const quality = useQualityStep(entry.manifest, surface === "local");
  const [saving, setSaving] = useState(false);

  const approve = async () => {
    if (quality && !draftsEqual(quality.draft, draftOf(quality.state.current))) {
      setSaving(true);
      const refused = await saveLibraryStandards(quality.draft);
      setSaving(false);
      if (refused.length > 0) {
        quality.setProblems(refused);
        return;
      }
    }
    onApprove();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-background rounded-lg border shadow-lg max-w-lg w-full max-h-full overflow-y-auto flex flex-col gap-4 p-5">
        <h3 className="text-lg font-semibold">
          {title ?? `Install ${entry.manifest.name ?? entry.appId}?`}
        </h3>
        {allAccess ? (
          <div className="text-sm">
            This app is the <span className="font-medium">User-Data-Owner</span>: read + write
            access to
            <span className="font-mono"> all files</span>, including unclassified ones.
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {entry.manifest.name ?? entry.appId}{" "}
            {grants.length === 0
              ? "doesn't access any of your files."
              : "asks for access to these files."}
          </p>
        )}

        {grants.length > 0 && (
          <ul className="flex flex-col gap-2">
            {grants.map((g, i) => {
              // Per design: any access (read or readwrite) implicitly grants
              // SELECT on the per-category metadata table. metadataWrite adds
              // INSERT/UPDATE on top of that read.
              const dataPermissions = g.access === "readwrite" ? "read + write" : "read";
              const metadataPermissions = g.metadataWrite ? "read + write" : "read";
              return (
                <Collapsible key={i} asChild>
                  <li className="border rounded-md p-3 flex flex-col gap-2">
                    <div className="flex items-center gap-2 text-sm flex-wrap">
                      <span className="font-medium">{categoriesOf(g.types)}</span>
                      <Badge variant="secondary" className="text-xs">
                        files: {dataPermissions}
                      </Badge>
                      <Badge variant="secondary" className="text-xs">
                        metadata: {metadataPermissions}
                      </Badge>
                      <CollapsibleTrigger className="group ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                        {g.types.length} {g.types.length === 1 ? "type" : "types"}
                        <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
                      </CollapsibleTrigger>
                    </div>
                    <CollapsibleContent>
                      <p className="font-mono text-xs text-muted-foreground">
                        {g.types.map((t) => t.split("/")[1] ?? t).join(", ")}
                      </p>
                    </CollapsibleContent>
                  </li>
                </Collapsible>
              );
            })}
          </ul>
        )}

        {publicSharingConsent(entry.manifest) && (
          <div className="border rounded-md p-3 text-sm flex flex-col gap-1">
            <span className="font-medium">Public links</span>
            <span className="text-muted-foreground">{publicSharingConsent(entry.manifest)}</span>
          </div>
        )}

        {quality && (
          <div className="border-t pt-4 flex flex-col gap-3">
            <h4 className="text-sm font-medium">Quality kept when originals archive</h4>
            <p className="text-xs text-muted-foreground">
              Larger originals archive to deep storage, and a copy at this size stays available. You
              can change this later on the Storage page.
            </p>
            <LibraryStandardsFields
              state={quality.state}
              draft={quality.draft}
              onChange={quality.setDraft}
              categories={quality.categories}
            />
            {quality.problems.length > 0 && (
              <ul className="text-sm text-destructive">
                {quality.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            onClick={() => void approve()}
            disabled={
              saving ||
              (quality !== null && draftProblems(quality.draft, quality.state.ranges).length > 0)
            }
          >
            {saving ? "Saving…" : surface === "mobile" ? "Approve & Register" : "Approve & Install"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The install flow's one-time quality step: shown for an app that reads photos
 * or videos while the person has set no value and the library holds none of
 * those originals yet. Null when the step does not apply, or while the daemon
 * has not answered — installing never waits on it. `enabled` is false outside
 * the local install, and the step then never asks the daemon.
 */
function useQualityStep(
  manifest: ManifestSummary,
  enabled: boolean,
): {
  state: LibraryStandardsResponse;
  draft: LibraryStandardsDraft;
  setDraft: (draft: LibraryStandardsDraft) => void;
  categories: Category[];
  problems: string[];
  setProblems: (problems: string[]) => void;
} | null {
  const [state, setState] = useState<LibraryStandardsResponse | null>(null);
  const [draft, setDraft] = useState<LibraryStandardsDraft | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  const read = mediaCategoriesRead(manifest);
  const wanted = enabled && read.length > 0;
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    fetch("/api/library/stand-in-standards")
      .then((r) => r.json())
      .then((body: LibraryStandardsResponse) => {
        if (cancelled || body.offline || !body.current) return;
        setState(body);
        setDraft(draftOf(body.current));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [wanted]);

  if (!wanted || !state || !draft || state.set) return null;
  const categories = read.filter((c) => state.libraryOriginals[c].count === 0);
  if (categories.length === 0) return null;
  return { state, draft, setDraft, categories, problems, setProblems };
}

/** The stand-in categories an app's manifest reads, in display order. */
function mediaCategoriesRead(manifest: ManifestSummary): Category[] {
  const types = (manifest.infraRequirements?.fileAccess ?? []).flatMap((g) => g.types);
  return (["image", "video"] as const).filter((c) => types.some((t) => t.startsWith(`${c}/`)));
}
