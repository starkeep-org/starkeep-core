"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { MoreHorizontalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// ---------------------------------------------------------------------------
// Shared shell for every app-like entry on the dashboard: local apps, cloud
// apps, and the built-in Drive. Each card offers exactly one primary button —
// the action the current state calls for — and hides the rest behind the
// overflow menu, so a card never presents three equally-weighted controls.
//
// Cards size themselves rather than filling the column, so a short list reads
// as a row of cards instead of a stack of full-width bars.
// ---------------------------------------------------------------------------

export interface AppCardAction {
  label: string;
  /** Runs the action. Omit when the entry navigates instead — see `href`. */
  onSelect?: () => void;
  /** Renders the entry as a link to another page. */
  href?: string;
  disabled?: boolean;
  destructive?: boolean;
  /** Native tooltip, used to explain why an action is disabled. */
  title?: string;
}

interface Props {
  name: string;
  /** Rendered next to the name; omitted for entries without a manifest. */
  version?: string;
  /** Status badges — installed, running, transitioning. */
  badges?: ReactNode;
  description?: ReactNode;
  /** The single button the current state calls for. */
  primary?: ReactNode;
  /** Secondary controls, reached through the overflow menu. */
  actions?: AppCardAction[];
}

export function AppCard({ name, version, badges, description, primary, actions }: Props) {
  const menuActions = actions?.filter(Boolean) ?? [];

  return (
    <Card size="sm" className="w-76 max-w-full">
      <CardHeader>
        <CardTitle className="flex items-baseline gap-2">
          <span className="truncate">{name}</span>
          {version && <span className="text-xs font-normal text-muted-foreground">v{version}</span>}
        </CardTitle>
        {menuActions.length > 0 && (
          <CardAction>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`More actions for ${name}`}
                >
                  <MoreHorizontalIcon />
                </Button>
              </DropdownMenuTrigger>
              {/* The menu primitive sizes itself to its trigger, and the
                  trigger is a 28px icon button — so the menu has to size to
                  its own labels instead, or "Redeploy Photos" wraps. */}
              <DropdownMenuContent align="end" className="w-auto min-w-44 max-w-80">
                {menuActions.map((action) => (
                  <DropdownMenuItem
                    key={action.label}
                    asChild={!!action.href}
                    variant={action.destructive ? "destructive" : "default"}
                    disabled={action.disabled}
                    title={action.title}
                    onSelect={action.onSelect}
                  >
                    {action.href ? <Link href={action.href}>{action.label}</Link> : action.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </CardAction>
        )}
        {description && <CardDescription className="line-clamp-3">{description}</CardDescription>}
      </CardHeader>

      {badges && (
        <CardContent className="flex flex-wrap items-center gap-1.5">{badges}</CardContent>
      )}

      {/* The primary action spans the card. `[&_button]:w-full` reaches the
          button inside a tooltip wrapper; `asChild` links are direct children
          and pick up `[&>*]:w-full` themselves. */}
      {primary && (
        <CardFooter className="gap-2 [&>*]:w-full [&_button]:w-full">{primary}</CardFooter>
      )}
    </Card>
  );
}

/** Wrapping row the app cards lay out in. */
export function AppCardGrid({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-start gap-3">{children}</div>;
}
