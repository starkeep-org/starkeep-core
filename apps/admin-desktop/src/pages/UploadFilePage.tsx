import { useState } from "react";
import {
  Title,
  FileInput,
  Button,
  Stack,
  Alert,
  Text,
  Group,
  Badge,
  Paper,
} from "@mantine/core";
import { useDataSource } from "../lib/data-source-context";
import { resolveDataSource } from "../lib/data-client";

function inferRecordType(file: File): string {
  if (file.type.startsWith("image/")) return "@starkeep/image";
  if (
    file.type === "text/markdown" ||
    file.name.endsWith(".md") ||
    file.name.endsWith(".markdown")
  )
    return "@starkeep/markdown";
  return "@starkeep/image"; // fallback
}

export function UploadFilePage() {
  const { mode } = useDataSource();
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    id: string;
    type: string;
    mimeType: string | null;
    sizeBytes: number | null;
  } | null>(null);

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    setError(null);
    setResult(null);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const uint8 = new Uint8Array(arrayBuffer);
      // Convert to base64 in chunks to avoid call stack overflow on large files
      let binary = "";
      const chunkSize = 8192;
      for (let i = 0; i < uint8.length; i += chunkSize) {
        binary += String.fromCharCode(...uint8.subarray(i, i + chunkSize));
      }
      const fileBase64 = btoa(binary);

      const recordType = inferRecordType(file);

      const { baseUrl, headers } = await resolveDataSource(mode);
      const response = await fetch(`${baseUrl}/data/records`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          type: recordType,
          payload: { fileName: file.name },
          fileName: file.name,
          contentType: file.type || "application/octet-stream",
          fileBase64,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${response.status}`);
      }

      const body = await response.json() as {
        record: { id: string; type: string; mime_type: string | null; size_bytes: number | null };
      };
      setResult({
        id: body.record.id,
        type: body.record.type,
        mimeType: body.record.mime_type,
        sizeBytes: body.record.size_bytes,
      });
      setFile(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <Stack gap="md" maw={600}>
      <Title order={3}>Upload File</Title>
      <Text c="dimmed" size="sm">
        Upload an image or markdown file. Use the navbar toggle to store to the
        {mode === "remote" ? " remote AWS service" : " local data server"}.
      </Text>

      <FileInput
        label="Select file"
        placeholder="Click to browse…"
        accept="image/*,text/markdown,.md,.markdown"
        value={file}
        onChange={setFile}
        clearable
      />

      {file && (
        <Paper withBorder p="sm" radius="sm">
          <Group gap="xs">
            <Text size="sm" fw={500}>
              {file.name}
            </Text>
            <Badge variant="light" size="sm">
              {inferRecordType(file)}
            </Badge>
            <Text size="xs" c="dimmed">
              {(file.size / 1024).toFixed(1)} KB
            </Text>
          </Group>
        </Paper>
      )}

      {error && (
        <Alert color="red" title="Upload failed">
          {error}
        </Alert>
      )}

      {result && (
        <Alert color="green" title="Upload successful">
          <Stack gap={4}>
            <Text size="sm">
              <strong>ID:</strong> {result.id}
            </Text>
            <Text size="sm">
              <strong>Type:</strong> {result.type}
            </Text>
            {result.sizeBytes != null && (
              <Text size="sm">
                <strong>Size:</strong> {(result.sizeBytes / 1024).toFixed(1)} KB
              </Text>
            )}
          </Stack>
        </Alert>
      )}

      <Button
        onClick={handleUpload}
        loading={uploading}
        disabled={!file}
        w="fit-content"
      >
        Upload
      </Button>
    </Stack>
  );
}
