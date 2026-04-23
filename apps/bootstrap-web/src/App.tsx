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
} from "@mantine/core";
import {
  generateSelfHostedBootstrapTemplate,
  getCloudFormationCreateStackUrl,
} from "@starkeep/admin-core";

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
    <Container size="sm" py="xl">
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
