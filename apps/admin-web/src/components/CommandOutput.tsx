"use client";

import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface Props {
  lines: string[];
  status: "idle" | "running" | "success" | "failure";
  className?: string;
}

export function CommandOutput({ lines, status, className }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  return (
    <div className={cn("rounded-md border", className)}>
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">Output</span>
        {status === "running" && (
          <div className="flex items-center gap-1.5">
            <div className="size-1.5 animate-pulse rounded-full bg-primary" />
            <span className="text-xs text-muted-foreground">Running</span>
          </div>
        )}
        {status === "success" && <Badge variant="secondary" className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">Done</Badge>}
        {status === "failure" && <Badge variant="destructive" className="text-xs">Failed</Badge>}
      </div>
      <ScrollArea className="h-64">
        <pre className="p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
          {lines.length === 0 && status === "running" ? (
            <span className="text-muted-foreground">Starting…</span>
          ) : (
            lines.join("\n")
          )}
        </pre>
        <div ref={bottomRef} />
      </ScrollArea>
    </div>
  );
}
