import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function StatusBadge({ online }: { online: boolean | null }) {
  if (online === null) {
    return <span className="size-4 animate-spin rounded-full border-2 border-border border-t-foreground" />;
  }
  return (
    <Badge
      variant="secondary"
      className={cn("text-xs", online
        ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
        : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200")}
    >
      {online ? "Online" : "Offline"}
    </Badge>
  );
}
