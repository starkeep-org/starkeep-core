import { Link } from "react-router";
import { Badge } from "@/components/ui/badge";
import { StandInsSection } from "../components/StandInsSection";
import { LibraryStandardsSection } from "../components/LibraryStandardsSection";

export function StoragePage() {
  return (
    <div className="p-6 max-w-5xl">
      <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
        ← Dashboard
      </Link>
      <div className="mt-2 mb-2 flex items-center gap-2">
        <h1 className="text-2xl font-semibold">Storage</h1>
        <Badge variant="outline" className="text-xs">Experimental</Badge>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        This machine keeps a copy of every file, except photo and video originals, which it
        downloads when you open one. It also keeps photo and video previews up to its
        ceiling. Turn on &quot;Keep originals here&quot; to keep every original too. Nothing is
        removed unless you free up space.
      </p>
      <div className="rounded-lg border p-6">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-5">
          Photos &amp; videos
        </h2>
        <div className="space-y-8">
          <LibraryStandardsSection />
          <StandInsSection />
        </div>
      </div>
    </div>
  );
}
