import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createPlan } from "../lib/api";
import {
  Container, Title, Text, Button, Select, Stack, Alert,
} from "@mantine/core";

const TEMPLATES = [
  { value: "web-app", label: "Static Website - S3 + CloudFront" },
  { value: "api-service", label: "API Service - Lambda + DynamoDB + API Gateway" },
  { value: "data-pipeline", label: "Data Pipeline - S3 + Glue + Athena" },
  { value: "immich", label: "Immich Photo Management - ECS + RDS + S3" },
];

const ENVIRONMENTS = [
  { value: "dev", label: "Development" },
  { value: "staging", label: "Staging" },
  { value: "prod", label: "Production" },
];

const REGIONS = [
  { value: "us-east-1", label: "us-east-1 (N. Virginia)" },
  { value: "us-east-2", label: "us-east-2 (Ohio)" },
  { value: "us-west-2", label: "us-west-2 (Oregon)" },
  { value: "eu-west-1", label: "eu-west-1 (Ireland)" },
  { value: "eu-central-1", label: "eu-central-1 (Frankfurt)" },
  { value: "ap-southeast-1", label: "ap-southeast-1 (Singapore)" },
  { value: "ap-northeast-1", label: "ap-northeast-1 (Tokyo)" },
];

export function NewDeploymentPage() {
  const navigate = useNavigate();
  const [template, setTemplate] = useState<string | null>(null);
  const [environment, setEnvironment] = useState<string | null>(null);
  const [region, setRegion] = useState<string | null>("us-east-1");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!template || !environment || !region) {
      setError("All fields are required");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const plan = await createPlan({
        stack_name: `app-${template}-${environment}`,
        region,
        environment,
        template_type: template,
        parameters: null,
      }) as { id: string };
      navigate(`/deployments/${plan.id}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Container size="sm">
      <Title order={1} mb="md">Create Deployment</Title>
      <Text c="dimmed" mb="xl">
        Select a template and environment to create a deployment plan.
      </Text>

      {error && (
        <Alert color="red" title="Error" mb="md">{error}</Alert>
      )}

      <form onSubmit={handleSubmit}>
        <Stack gap="md">
          <Select
            label="Template"
            placeholder="Select a template..."
            data={TEMPLATES}
            value={template}
            onChange={setTemplate}
            required
            withAsterisk
          />

          <Select
            label="Environment"
            placeholder="Select environment..."
            data={ENVIRONMENTS}
            value={environment}
            onChange={setEnvironment}
            required
            withAsterisk
          />

          <Select
            label="AWS Region"
            placeholder="Select region..."
            data={REGIONS}
            value={region}
            onChange={setRegion}
            required
            withAsterisk
          />

          <Button type="submit" size="lg" fullWidth loading={submitting}>
            {submitting ? "Creating..." : "Create Plan"}
          </Button>
        </Stack>
      </form>
    </Container>
  );
}
