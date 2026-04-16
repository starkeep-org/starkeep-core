import { Stack, Text, Button, Code } from "@mantine/core";
import type { StackOutputItem } from "../types.js";

export interface StackOutputsProps {
  outputs: StackOutputItem[];
}

export function StackOutputs({ outputs }: StackOutputsProps) {
  if (outputs.length === 0) return null;

  return (
    <Stack gap="md">
      {outputs.map((output, idx) => (
        <div key={idx}>
          <Text fw={700} size="sm" mb="xs">{output.outputKey}</Text>
          {output.description && (
            <Text size="xs" c="dimmed" mb="xs">{output.description}</Text>
          )}
          {output.outputValue.startsWith("http") ? (
            <Button
              component="a"
              href={output.outputValue}
              target="_blank"
              rel="noopener noreferrer"
              variant="light"
              size="sm"
            >
              {output.outputValue}
            </Button>
          ) : (
            <Code>{output.outputValue}</Code>
          )}
        </div>
      ))}
    </Stack>
  );
}
