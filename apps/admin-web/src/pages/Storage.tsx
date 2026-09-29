import { Link } from "react-router";
import { Badge } from "@/components/ui/badge";
import { StandInsSection } from "../components/StandInsSection";

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
        This machine keeps every file, except photos, videos and audio larger than its
        ceiling, which it fetches when you open them. Nothing is removed unless you free
        up space.
      </p>
      <div className="rounded-lg border p-6">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-5">
          Photos, videos &amp; audio
        </h2>
        <StandInsSection />
      </div>
    </div>
  );
}
