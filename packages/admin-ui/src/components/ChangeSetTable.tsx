import { Table, Badge, Code, Text } from "@mantine/core";
import type { ChangeSetChangeItem } from "../types.js";

export interface ChangeSetTableProps {
  changes: ChangeSetChangeItem[];
}

export function ChangeSetTable({ changes }: ChangeSetTableProps) {
  if (changes.length === 0) return null;

  return (
    <Table striped highlightOnHover>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Action</Table.Th>
          <Table.Th>Resource Type</Table.Th>
          <Table.Th>Logical ID</Table.Th>
          <Table.Th>Replacement</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {changes.map((change, idx) => {
          const rc = change.ResourceChange;
          if (!rc) return null;

          const actionColor =
            rc.Action === "Add" ? "green" :
            rc.Action === "Remove" ? "red" :
            "orange";

          return (
            <Table.Tr key={idx}>
              <Table.Td>
                <Badge color={actionColor}>{rc.Action}</Badge>
              </Table.Td>
              <Table.Td>
                <Code>{rc.ResourceType}</Code>
              </Table.Td>
              <Table.Td>{rc.LogicalResourceId}</Table.Td>
              <Table.Td>
                {rc.Replacement === "True" ? (
                  <Badge color="orange">Yes</Badge>
                ) : rc.Replacement === "False" ? (
                  <Badge color="blue">No</Badge>
                ) : (
                  <Text c="dimmed">N/A</Text>
                )}
              </Table.Td>
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}
