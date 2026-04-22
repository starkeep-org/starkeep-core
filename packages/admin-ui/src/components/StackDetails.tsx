import { Stack, Text, Code, Badge } from "@mantine/core";

export interface StackDetailsProps {
  stackName: string;
  region: string;
  environment: string | null;
  changeSetId?: string | null;
  stackId?: string | null;
  createdAt?: string | Date;
  startedAt?: string | Date | null;
  completedAt?: string | Date | null;
}

export function StackDetails(props: StackDetailsProps) {
  return (
    <Stack gap="sm">
      <div>
        <Text fw={700} span>Stack Name:</Text> <Code ml="xs">{props.stackName}</Code>
      </div>
      <div>
        <Text fw={700} span>Region:</Text> <Code ml="xs">{props.region}</Code>
      </div>
      <div>
        <Text fw={700} span>Environment:</Text> <Badge ml="xs">{props.environment}</Badge>
      </div>
      {props.changeSetId && (
        <div>
          <Text fw={700} span>Change Set ID:</Text> <Code ml="xs">{props.changeSetId}</Code>
        </div>
      )}
      {props.stackId && (
        <div>
          <Text fw={700} span>Stack ID:</Text> <Code ml="xs" style={{ fontSize: "0.75rem" }}>{props.stackId}</Code>
        </div>
      )}
      {props.createdAt && (
        <div>
          <Text fw={700} span>Created:</Text> <Text ml="xs" span>{new Date(props.createdAt).toLocaleString()}</Text>
        </div>
      )}
      {props.startedAt && (
        <div>
          <Text fw={700} span>Started:</Text> <Text ml="xs" span>{new Date(props.startedAt).toLocaleString()}</Text>
        </div>
      )}
      {props.completedAt && (
        <div>
          <Text fw={700} span>Completed:</Text> <Text ml="xs" span>{new Date(props.completedAt).toLocaleString()}</Text>
        </div>
      )}
    </Stack>
  );
}
