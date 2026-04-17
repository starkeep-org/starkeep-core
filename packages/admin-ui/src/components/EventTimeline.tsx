import { Timeline, Code, Badge, Group, Text } from "@mantine/core";
import type { DeploymentEventItem } from "../types.js";

export interface EventTimelineProps {
  events: DeploymentEventItem[];
}

export function EventTimeline({ events }: EventTimelineProps) {
  if (events.length === 0) return null;

  return (
    <Timeline active={events.length} bulletSize={24} lineWidth={2}>
      {events.map((event, idx) => {
        const isError = event.resourceStatus.includes("FAILED");
        const isComplete = event.resourceStatus.includes("COMPLETE");
        const color = isError ? "red" : isComplete ? "green" : "blue";

        return (
          <Timeline.Item
            key={idx}
            bullet={isError ? "\u2717" : isComplete ? "\u2713" : "\u2022"}
            title={
              <Group gap="xs">
                <Code>{event.logicalResourceId}</Code>
                <Badge color={color} size="sm">{event.resourceStatus}</Badge>
              </Group>
            }
          >
            <Text size="sm" c="dimmed">{event.resourceType}</Text>
            {event.resourceStatusReason && (
              <Text size="sm" c={isError ? "red" : "dimmed"} mt="xs">
                {event.resourceStatusReason}
              </Text>
            )}
            <Text size="xs" c="dimmed" mt="xs">
              {new Date(event.timestamp).toLocaleTimeString()}
            </Text>
          </Timeline.Item>
        );
      })}
    </Timeline>
  );
}
