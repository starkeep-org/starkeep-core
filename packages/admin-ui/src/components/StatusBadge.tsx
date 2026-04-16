import { Badge } from "@mantine/core";

const STATUS_COLORS: Record<string, string> = {
  READY: "green",
  EXECUTING: "blue",
  COMPLETED: "teal",
  IN_PROGRESS: "blue",
  FAILED: "red",
  NOT_STARTED: "gray",
};

export interface StatusBadgeProps {
  status: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
}

export function StatusBadge({ status, size }: StatusBadgeProps) {
  const color = STATUS_COLORS[status] ?? "gray";
  return <Badge color={color} size={size}>{status}</Badge>;
}
