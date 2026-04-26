"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Container,
  Title,
  Text,
  Paper,
  Stack,
  Group,
  Badge,
  Loader,
  Alert,
  Button,
  Code,
  Collapse,
  Divider,
} from "@mantine/core";
import {
  generateSelfHostedPermissionsTemplate,
  deployPermissionStatements,
  statementMetadata,
  type IamStatement,
} from "@starkeep/admin-core";
import { readCloudConfig, readCloudCredentials, type CloudConfig } from "../../../src/lib/cloud-config";
import type { STSCredentials } from "../../../src/lib/cognito-auth";
import {
  getPermissionsStackStatus,
  getCurrentTemplate,
  createPermissionsStack,
  updatePermissionsStack,
  deletePermissionsStack,
  pollUntilTerminal,
  isSuccess,
  templatesAreEquivalent,
  type PermissionsStackStatus,
} from "../../../src/lib/permissions-stack-client";

type PageState =
  | { kind: "loading" }
  | { kind: "no-config" }
  | { kind: "ready"; data: ReadyData };

interface ReadyData {
  config: CloudConfig;
  creds: STSCredentials;
  stackName: string;
  status: PermissionsStackStatus;
  currentTemplate: string | null;
  desiredTemplate: string;
  needsUpdate: boolean;
}

function groupStatementsByApp(statements: IamStatement[]): Map<string, IamStatement[]> {
  const groups = new Map<string, IamStatement[]>();
  for (const stmt of statements) {
    const meta = statementMetadata[stmt.Sid];
    const tags = meta?.requiredBy ?? ["other"];
    for (const tag of tags) {
      const list = groups.get(tag) ?? [];
      list.push(stmt);
      groups.set(tag, list);
    }
  }
  return groups;
}

const REQUIRED_BY_LABELS: Record<string, string> = {
  sst: "SST framework (bootstrap + state)",
  "sst-bootstrap": "SST first-run bootstrap",
  "user-data:dsql": "User data — Aurora DSQL cluster",
  "user-data:s3": "User data — S3 file storage",
  "user-data:lambda": "User data — Lambda functions",
  "user-data:api-gateway": "User data — API Gateway HTTP API",
  "desktop:dsql-direct": "Desktop — direct DSQL connection",
  "remote-deploy": "Remote CodeBuild deploy",
};

export default function PermissionsPage() {
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [showStatements, setShowStatements] = useState(false);
  const [showTemplate, setShowTemplate] = useState(false);

  const refresh = useCallback(async () => {
    const config = await readCloudConfig();
    const creds = await readCloudCredentials();
    if (!config || !creds) {
      setState({ kind: "no-config" });
      return;
    }
    const stackName = `${config.stackPrefix}-deploy-permissions`;
    const region = config.cognitoConfig.region;
    const desiredTemplate = generateSelfHostedPermissionsTemplate({
      stackPrefix: config.stackPrefix,
    });

    const status = await getPermissionsStackStatus(creds, region, stackName);
    let currentTemplate: string | null = null;
    if (status.phase !== "NOT_FOUND") {
      currentTemplate = await getCurrentTemplate(creds, region, stackName);
    }

    const needsUpdate =
      status.phase === "NOT_FOUND" ||
      (currentTemplate !== null && !templatesAreEquivalent(currentTemplate, desiredTemplate));

    setState({
      kind: "ready",
      data: { config, creds, stackName, status, currentTemplate, desiredTemplate, needsUpdate },
    });
  }, []);

  useEffect(() => {
    refresh().catch((err) => {
      setError(String(err instanceof Error ? err.message : err));
      setState({ kind: "no-config" });
    });
  }, [refresh]);

  const handleCreate = async (data: ReadyData) => {
    setBusy(true);
    setError(null);
    setPhase("Creating permissions stack…");
    try {
      await createPermissionsStack(
        data.creds,
        data.config.cognitoConfig.region,
        data.stackName,
        data.desiredTemplate,
      );
      const finalStatus = await pollUntilTerminal(
        data.creds,
        data.config.cognitoConfig.region,
        data.stackName,
        { onUpdate: (s) => setPhase(`Stack status: ${s.phase}`) },
      );
      if (!isSuccess(finalStatus)) {
        throw new Error(
          `Stack create finished with ${finalStatus.phase}${finalStatus.reason ? `: ${finalStatus.reason}` : ""}`,
        );
      }
      setPhase("Stack created.");
      await refresh();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  const handleUpdate = async (data: ReadyData) => {
    setBusy(true);
    setError(null);
    setPhase("Updating permissions stack…");
    try {
      const result = await updatePermissionsStack(
        data.creds,
        data.config.cognitoConfig.region,
        data.stackName,
        data.desiredTemplate,
      );
      if (result.noChanges) {
        setPhase("No changes to apply.");
        await refresh();
        return;
      }
      const finalStatus = await pollUntilTerminal(
        data.creds,
        data.config.cognitoConfig.region,
        data.stackName,
        { onUpdate: (s) => setPhase(`Stack status: ${s.phase}`) },
      );
      if (!isSuccess(finalStatus)) {
        throw new Error(
          `Stack update finished with ${finalStatus.phase}${finalStatus.reason ? `: ${finalStatus.reason}` : ""}`,
        );
      }
      setPhase("Stack updated.");
      await refresh();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (data: ReadyData) => {
    if (
      !window.confirm(
        `Delete the ${data.stackName} stack? This will detach the deploy permissions managed policy from both roles. You will not be able to deploy until you re-create it.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setPhase("Deleting permissions stack…");
    try {
      await deletePermissionsStack(
        data.creds,
        data.config.cognitoConfig.region,
        data.stackName,
      );
      const finalStatus = await pollUntilTerminal(
        data.creds,
        data.config.cognitoConfig.region,
        data.stackName,
        { onUpdate: (s) => setPhase(`Stack status: ${s.phase}`) },
      );
      if (finalStatus.phase !== "NOT_FOUND" && finalStatus.phase !== "DELETE_COMPLETE") {
        throw new Error(
          `Stack delete finished with ${finalStatus.phase}${finalStatus.reason ? `: ${finalStatus.reason}` : ""}`,
        );
      }
      setPhase("Stack deleted.");
      await refresh();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  if (state.kind === "loading") {
    return (
      <Container size="md" py="xl">
        <Group gap="sm">
          <Loader size="sm" />
          <Text>Loading permissions stack status…</Text>
        </Group>
      </Container>
    );
  }

  if (state.kind === "no-config") {
    return (
      <Container size="md" py="xl">
        <Stack>
          <Title order={2}>Deploy permissions</Title>
          <Alert color="yellow">
            No cloud configuration found. Complete the cloud setup wizard first.
          </Alert>
          {error && <Alert color="red">{error}</Alert>}
        </Stack>
      </Container>
    );
  }

  const { data } = state;
  const statements = deployPermissionStatements();
  const groups = groupStatementsByApp(statements);

  return (
    <Container size="md" py="xl">
      <Stack gap="lg">
        <Group justify="space-between" align="flex-end">
          <Stack gap={4}>
            <Title order={2}>Deploy permissions</Title>
            <Text c="dimmed" size="sm">
              Manages the <Code>{data.stackName}</Code> CloudFormation stack — a single managed policy
              attached to your desktop role and CodeBuild service role. Updating permissions does not
              require re-bootstrapping.
            </Text>
          </Stack>
          <StatusBadge status={data.status} />
        </Group>

        {error && (
          <Alert color="red" title="Error">
            {error}
          </Alert>
        )}

        {phase && busy && (
          <Paper withBorder p="sm">
            <Group gap="sm">
              <Loader size="xs" />
              <Text size="sm" c="dimmed">
                {phase}
              </Text>
            </Group>
          </Paper>
        )}

        {data.status.phase === "NOT_FOUND" && (
          <Alert color="blue" title="Permissions stack not yet created">
            The bootstrap stack created your desktop and CodeBuild roles, but neither has the
            permissions to actually deploy yet. Click below to create the deploy-permissions stack.
          </Alert>
        )}

        {data.status.phase !== "NOT_FOUND" && data.needsUpdate && (
          <Alert color="orange" title="Update available">
            The deployed managed policy differs from the latest spec bundled with this admin-web
            build. Click <strong>Update</strong> to apply the latest permissions.
          </Alert>
        )}

        {data.status.phase !== "NOT_FOUND" && !data.needsUpdate && (
          <Alert color="green" title="Up to date">
            Deployed managed policy matches the latest spec.
          </Alert>
        )}

        <Group>
          {data.status.phase === "NOT_FOUND" ? (
            <Button loading={busy} onClick={() => handleCreate(data)}>
              Create permissions stack
            </Button>
          ) : (
            <Button
              loading={busy}
              disabled={!data.needsUpdate}
              onClick={() => handleUpdate(data)}
            >
              Update permissions stack
            </Button>
          )}
          {data.status.phase !== "NOT_FOUND" && (
            <Button
              variant="subtle"
              color="red"
              loading={busy}
              onClick={() => handleDelete(data)}
            >
              Delete permissions stack
            </Button>
          )}
          <Button variant="subtle" disabled={busy} onClick={refresh}>
            Refresh
          </Button>
        </Group>

        <Divider label="Permissions in this stack" labelPosition="left" />

        <Button variant="subtle" onClick={() => setShowStatements((v) => !v)}>
          {showStatements ? "Hide" : "Show"} statement list ({statements.length} statements)
        </Button>

        <Collapse in={showStatements}>
          <Stack gap="md">
            {Array.from(groups.entries()).map(([tag, stmts]) => (
              <Paper key={tag} withBorder p="md">
                <Stack gap="xs">
                  <Group gap="xs">
                    <Badge variant="light">{REQUIRED_BY_LABELS[tag] ?? tag}</Badge>
                    <Text size="xs" c="dimmed">
                      {stmts.length} statement{stmts.length === 1 ? "" : "s"}
                    </Text>
                  </Group>
                  {stmts.map((stmt) => {
                    const meta = statementMetadata[stmt.Sid];
                    return (
                      <Stack key={stmt.Sid} gap={2}>
                        <Group gap="xs">
                          <Code>{stmt.Sid}</Code>
                          <Text size="sm" fw={500}>
                            {meta?.label ?? stmt.Sid}
                          </Text>
                        </Group>
                        {meta?.reason && (
                          <Text size="xs" c="dimmed">
                            {meta.reason}
                          </Text>
                        )}
                      </Stack>
                    );
                  })}
                </Stack>
              </Paper>
            ))}
          </Stack>
        </Collapse>

        <Button variant="subtle" onClick={() => setShowTemplate((v) => !v)}>
          {showTemplate ? "Hide" : "Show"} CloudFormation template
        </Button>

        <Collapse in={showTemplate}>
          <Paper withBorder p="md">
            <Code block style={{ maxHeight: 400, overflow: "auto", fontSize: 11 }}>
              {data.desiredTemplate}
            </Code>
          </Paper>
        </Collapse>
      </Stack>
    </Container>
  );
}

function StatusBadge({ status }: { status: PermissionsStackStatus }) {
  const color = status.phase.includes("FAILED")
    ? "red"
    : status.phase.includes("ROLLBACK")
      ? "orange"
      : status.phase.includes("IN_PROGRESS")
        ? "blue"
        : status.phase === "NOT_FOUND"
          ? "gray"
          : "green";
  return (
    <Badge color={color} size="lg">
      {status.phase}
    </Badge>
  );
}
