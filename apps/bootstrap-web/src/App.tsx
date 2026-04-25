import { useState } from "react";
import {
  Container,
  Title,
  Text,
  Button,
  Stack,
  Alert,
  TextInput,
  Paper,
  Code,
  Group,
  Table,
  Divider,
} from "@mantine/core";
import {
  generateSelfHostedBootstrapTemplate,
  getCloudFormationCreateStackUrl,
} from "@starkeep/admin-core";

function LandingSection() {
  return (
    <Stack gap="xl" mb="xl">
      <Stack gap="xs">
        <Title order={1}>Starkeep</Title>
        <Title order={3} c="dimmed" fw={400}>
          Your data. Your apps. Your infra.
        </Title>
      </Stack>

      <Stack gap="md">
        <Text>
          Starkeep is a free open-source SDK and app ecosystem that runs locally and on AWS
          Serverless (S3, DSQL, Lambdas) with full two-way data sync.
        </Text>
        <Text>
          Run apps with the full power and cost efficiency of AWS serverless cloud with your own AWS
          account while your data never leaves your control.
        </Text>
        <Text>
          Easily set up your own Starkeep service for free with no Starkeep account required, just
          your own free AWS account you create yourself.
        </Text>
      </Stack>

      <Stack gap="lg">
        <Stack gap="xs">
          <Title order={3}>Data Management</Title>
          <Table striped withTableBorder withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th></Table.Th>
                <Table.Th>Starkeep</Table.Th>
                <Table.Th>Traditional self-hosting</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {[
                ["All your apps access a common shared data store", "Yes", "No, each app can only access its own data store"],
                ["Built-in local-cloud data sync", "Yes", "Depends on the app"],
                ["Built-in cross-device data sync", "Yes", "Depends on the app"],
                ["Supports preserving local filesystem structure in-place", "Yes", "Depends on the app"],
                ["Enterprise-grade backup built-in", "Yes", "No"],
                ["Data versioning", "Yes, built-in", "No"],
                ["Your data is decoupled from apps for maximum portability", "Yes", "Usually not"],
              ].map(([feature, sk, trad]) => (
                <Table.Tr key={feature}>
                  <Table.Td>{feature}</Table.Td>
                  <Table.Td>{sk}</Table.Td>
                  <Table.Td>{trad}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Stack>

        <Stack gap="xs">
          <Title order={3}>Cost</Title>
          <Table striped withTableBorder withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th></Table.Th>
                <Table.Th>Starkeep</Table.Th>
                <Table.Th>Traditional self-hosting</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {[
                ["Cost scales to zero with generous free tier", "Yes", "No, substantial cost floor"],
                ["Pay for actual usage only", "Yes", "No, must pay for idle server time"],
              ].map(([feature, sk, trad]) => (
                <Table.Tr key={feature}>
                  <Table.Td>{feature}</Table.Td>
                  <Table.Td>{sk}</Table.Td>
                  <Table.Td>{trad}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Stack>

        <Stack gap="xs">
          <Title order={3}>Developer Experience</Title>
          <Table striped withTableBorder withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th></Table.Th>
                <Table.Th>Starkeep</Table.Th>
                <Table.Th>Traditional self-hosting</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {[
                ["Apps can reuse common resources like database and API endpoints", "Yes", "No"],
                ["All apps share the same pattern for storing and accessing data", "Yes", "No"],
                ["Easy to develop your own apps and services", "Yes", "Maybe"],
              ].map(([feature, sk, trad]) => (
                <Table.Tr key={feature}>
                  <Table.Td>{feature}</Table.Td>
                  <Table.Td>{sk}</Table.Td>
                  <Table.Td>{trad}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Stack>
      </Stack>
    </Stack>
  );
}

const ADMIN_WEB_URL = import.meta.env.VITE_ADMIN_WEB_URL ?? "http://localhost:3000";

function openUrl(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

function downloadTemplate(yaml: string) {
  const blob = new Blob([yaml], { type: "text/yaml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "starkeep-bootstrap-template.yaml";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function App() {
  const [region, setRegion] = useState("us-east-1");
  const [stackPrefix, setStackPrefix] = useState("starkeep");
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSaveTemplate = async () => {
    setSaving(true);
    setError(null);
    try {
      const yaml = generateSelfHostedBootstrapTemplate({ stackPrefix });
      downloadTemplate(yaml);
      setSavedPath("starkeep-bootstrap-template.yaml (downloaded)");
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleContinue = () => {
    const params = new URLSearchParams({ mode: "resume", region, stackPrefix });
    window.location.href = `${ADMIN_WEB_URL}/cloud-setup?${params}`;
  };

  return (
    <Container size="md" py="xl">
      <LandingSection />
      <Divider my="xl" />
      <Title order={2} mb="xs">
        Set up Starkeep Cloud
      </Title>
      <Text c="dimmed" mb="xl">
        Starkeep Cloud runs entirely on <strong>your own AWS account</strong> — your data never
        leaves infrastructure you control. You&apos;ll need an AWS account —{" "}
        <a href="https://aws.amazon.com/free" target="_blank" rel="noopener noreferrer">
          create a free one here
        </a>
        .
      </Text>

      <Stack gap="md">
        <Text>
          We will create a CloudFormation stack in your AWS account that sets up Cognito
          authentication and the IAM permissions needed to deploy your data infrastructure.
        </Text>

        <TextInput
          label="AWS Region"
          description="The AWS region where your Starkeep infrastructure will be deployed."
          placeholder="us-east-1"
          value={region}
          onChange={(e) => setRegion(e.currentTarget.value)}
        />

        <TextInput
          label="Stack prefix"
          description="A short name used to prefix all Starkeep resources (e.g. 'starkeep'). Lowercase letters, numbers, and hyphens only."
          placeholder="starkeep"
          value={stackPrefix}
          onChange={(e) => setStackPrefix(e.currentTarget.value.toLowerCase())}
        />

        {error && <Alert color="red" title="Error">{error}</Alert>}

        <Paper p="md" withBorder>
          <Stack gap="sm">
            <Text fw={500}>Step 1 — Download the bootstrap template</Text>
            <Text size="sm" c="dimmed">
              This generates a CloudFormation template file and downloads it to your browser.
            </Text>
            <Button
              variant="light"
              loading={saving}
              onClick={handleSaveTemplate}
              disabled={!stackPrefix || !region}
            >
              Download bootstrap template
            </Button>
            {savedPath && (
              <Text size="sm" c="green">
                Downloaded: <Code>{savedPath}</Code>
              </Text>
            )}
          </Stack>
        </Paper>

        <Paper p="md" withBorder>
          <Stack gap="sm">
            <Text fw={500}>Step 2 — Open the AWS CloudFormation console</Text>
            <Text size="sm" c="dimmed">
              In the CloudFormation console, choose <strong>Upload a template file</strong> and
              upload the file you downloaded above. Name the stack{" "}
              <Code>{stackPrefix ? `${stackPrefix}-bootstrap` : "starkeep-bootstrap"}</Code> and
              leave <strong>StackPrefix</strong> as <Code>{stackPrefix || "starkeep"}</Code>.
            </Text>
            <Button
              variant="light"
              onClick={() => openUrl(getCloudFormationCreateStackUrl(region))}
              disabled={!region}
            >
              Open CloudFormation console ({region || "select region first"})
            </Button>
          </Stack>
        </Paper>

        <Text size="sm" c="dimmed">
          After the stack reaches <strong>CREATE_COMPLETE</strong> status, click Continue.
        </Text>

        <Group justify="flex-end" mt="md">
          <Button onClick={handleContinue} disabled={!region || !stackPrefix}>
            Stack is deployed — Continue to Starkeep setup
          </Button>
        </Group>
      </Stack>
    </Container>
  );
}
