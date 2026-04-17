import { Table, Code } from "@mantine/core";

export interface ParametersTableProps {
  parameters: Record<string, unknown>;
}

export function ParametersTable({ parameters }: ParametersTableProps) {
  const entries = Object.entries(parameters);
  if (entries.length === 0) return null;

  return (
    <Table>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Parameter</Table.Th>
          <Table.Th>Value</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {entries.map(([key, value]) => (
          <Table.Tr key={key}>
            <Table.Td><Code>{key}</Code></Table.Td>
            <Table.Td>{String(value)}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
