import { useState, useEffect, useCallback } from "react";
import {
  Container, Title, Table, Text, Group, Button, Loader, Alert,
  Badge, Paper, Code, Stack, JsonInput, SimpleGrid,
} from "@mantine/core";
import { useDataSource } from "../lib/data-source-context";
import { resolveDataSource } from "../lib/data-client";
import type { DataSourceMode } from "../lib/data-client";

interface TypeSummary {
  record_type: string;
  count: number;
  latest_updated: string | null;
}

interface DataRecord {
  id: string;
  kind: string;
  type: string;
  created_at: string;
  updated_at: string;
  owner_id: string;
  sync_status: string;
  version: number;
  payload: Record<string, unknown> | null;
  content_hash: string | null;
  object_storage_key: string | null;
  mime_type: string | null;
  size_bytes: number | null;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

function useDataServer<T>(path: string, mode: DataSourceMode) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    resolveDataSource(mode)
      .then(({ baseUrl, headers }) => fetch(`${baseUrl}${path}`, { headers }))
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(setData)
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [path, mode]);

  useEffect(() => { refetch(); }, [refetch]);

  return { data, loading, error, refetch };
}

export function FileBrowserPage() {
  const { mode } = useDataSource();
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<DataRecord | null>(null);

  const { data: typesData, loading, error } = useDataServer<{ types: TypeSummary[]; total: number }>("/data/types", mode);

  if (!selectedType) {
    return (
      <Container size="xl">
        <Group justify="space-between" mb="lg">
          <div>
            <Title order={1}>Data Browser</Title>
            <Text size="sm" c="dimmed" mt={4}>
              {typesData ? `${typesData.total} records` : ""} in the Starkeep data store
            </Text>
          </div>
        </Group>

        {error && <Alert color="red" title="Error" mb="md">{error}</Alert>}

        {loading ? (
          <Group justify="center" py="xl"><Loader /></Group>
        ) : !typesData || typesData.types.length === 0 ? (
          <Paper p="xl" withBorder>
            <Stack align="center" gap="sm">
              <Text size="lg" fw={500}>No data yet</Text>
              <Text c="dimmed" ta="center">
                The Starkeep data store is empty. Install an app or use the SDK to create records.
              </Text>
            </Stack>
          </Paper>
        ) : (
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
            {typesData.types.map((t) => (
              <Paper
                key={t.record_type}
                p="lg"
                withBorder
                style={{ cursor: "pointer" }}
                onClick={() => setSelectedType(t.record_type)}
              >
                <Group justify="space-between" mb="xs">
                  <Code fw={600}>{t.record_type}</Code>
                  <Badge variant="light" size="lg">{t.count}</Badge>
                </Group>
                {t.latest_updated && (
                  <Text size="xs" c="dimmed">
                    Updated {new Date(t.latest_updated).toLocaleString()}
                  </Text>
                )}
              </Paper>
            ))}
          </SimpleGrid>
        )}
      </Container>
    );
  }

  if (selectedRecord) {
    return <RecordDetail record={selectedRecord} onBack={() => setSelectedRecord(null)} />;
  }

  return (
    <RecordsList
      recordType={selectedType}
      onBack={() => setSelectedType(null)}
      onSelectRecord={setSelectedRecord}
    />
  );
}

function RecordsList({
  recordType,
  onBack,
  onSelectRecord,
}: {
  recordType: string;
  onBack: () => void;
  onSelectRecord: (r: DataRecord) => void;
}) {
  const { mode } = useDataSource();
  const { data, loading, error } = useDataServer<{ records: DataRecord[] }>(
    `/data/records?type=${encodeURIComponent(recordType)}&limit=100`,
    mode,
  );

  return (
    <Container size="xl">
      <Button variant="subtle" size="sm" mb="md" onClick={onBack}>
        &larr; All Types
      </Button>

      <Group justify="space-between" mb="lg">
        <Group gap="sm">
          <Title order={1}>Records</Title>
          <Code fz="lg">{recordType}</Code>
        </Group>
        <Badge size="lg">{data?.records.length ?? 0}</Badge>
      </Group>

      {error && <Alert color="red" title="Error" mb="md">{error}</Alert>}

      {loading ? (
        <Group justify="center" py="xl"><Loader /></Group>
      ) : !data || data.records.length === 0 ? (
        <Text c="dimmed">No records of this type.</Text>
      ) : (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>ID</Table.Th>
              <Table.Th>Sync</Table.Th>
              <Table.Th>Size</Table.Th>
              <Table.Th>Updated</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.records.map((record) => (
              <Table.Tr
                key={record.id}
                style={{ cursor: "pointer" }}
                onClick={() => onSelectRecord(record)}
              >
                <Table.Td><Code fz="xs">{record.id}</Code></Table.Td>
                <Table.Td>
                  <Badge
                    size="sm"
                    color={record.sync_status === "synced" ? "green" : record.sync_status === "local" ? "gray" : "yellow"}
                  >
                    {record.sync_status}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {record.size_bytes != null ? formatSize(record.size_bytes) : "\u2014"}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">{new Date(record.updated_at).toLocaleString()}</Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Container>
  );
}

function RecordDetail({ record, onBack }: { record: DataRecord; onBack: () => void }) {
  return (
    <Container size="md">
      <Button variant="subtle" size="sm" mb="md" onClick={onBack}>
        &larr; Back to Records
      </Button>

      <Group justify="space-between" mb="lg">
        <Title order={1}>Record Detail</Title>
        <Badge color={record.sync_status === "synced" ? "green" : "gray"}>
          {record.sync_status}
        </Badge>
      </Group>

      <Stack gap="md">
        <Paper p="lg" withBorder>
          <Title order={4} mb="sm">Metadata</Title>
          <Table>
            <Table.Tbody>
              <Table.Tr><Table.Td fw={600} w={140}>ID</Table.Td><Table.Td><Code fz="xs">{record.id}</Code></Table.Td></Table.Tr>
              <Table.Tr><Table.Td fw={600}>Type</Table.Td><Table.Td><Code>{record.type}</Code></Table.Td></Table.Tr>
              <Table.Tr><Table.Td fw={600}>Owner</Table.Td><Table.Td><Code fz="xs">{record.owner_id}</Code></Table.Td></Table.Tr>
              <Table.Tr><Table.Td fw={600}>Version</Table.Td><Table.Td>{record.version}</Table.Td></Table.Tr>
              <Table.Tr><Table.Td fw={600}>Created</Table.Td><Table.Td>{new Date(record.created_at).toLocaleString()}</Table.Td></Table.Tr>
              <Table.Tr><Table.Td fw={600}>Updated</Table.Td><Table.Td>{new Date(record.updated_at).toLocaleString()}</Table.Td></Table.Tr>
              {record.mime_type && <Table.Tr><Table.Td fw={600}>MIME Type</Table.Td><Table.Td><Code>{record.mime_type}</Code></Table.Td></Table.Tr>}
              {record.size_bytes != null && <Table.Tr><Table.Td fw={600}>Size</Table.Td><Table.Td>{formatSize(record.size_bytes)}</Table.Td></Table.Tr>}
              {record.content_hash && <Table.Tr><Table.Td fw={600}>Content Hash</Table.Td><Table.Td><Code fz="xs">{record.content_hash}</Code></Table.Td></Table.Tr>}
              {record.object_storage_key && <Table.Tr><Table.Td fw={600}>Storage Key</Table.Td><Table.Td><Code fz="xs">{record.object_storage_key}</Code></Table.Td></Table.Tr>}
            </Table.Tbody>
          </Table>
        </Paper>

        {record.payload && Object.keys(record.payload).length > 0 && (
          <Paper p="lg" withBorder>
            <Title order={4} mb="sm">Payload</Title>
            <JsonInput
              value={JSON.stringify(record.payload, null, 2)}
              readOnly
              autosize
              minRows={3}
              maxRows={20}
              styles={{ input: { fontFamily: "monospace", fontSize: "0.85rem" } }}
            />
          </Paper>
        )}
      </Stack>
    </Container>
  );
}
