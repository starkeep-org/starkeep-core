"use client";

import { useState } from "react";
import {
  Text,
  Stack,
  Paper,
  Divider,
  Anchor,
  Collapse,
  Group,
  TextInput,
  Button,
  Code,
} from "@mantine/core";

export type SetupMode = "fresh" | "resume" | "signin";

function openUrl(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

export function ModeSelector({ onSelect }: { onSelect: (mode: SetupMode) => void }) {
  const [showClearPanel, setShowClearPanel] = useState(false);
  const [clearRegion, setClearRegion] = useState("us-east-1");
  const [clearPrefix, setClearPrefix] = useState("starkeep");

  return (
    <Stack gap="lg">
      <Text>
        Your Starkeep Cloud bootstrap stack is already deployed. Choose an option below to continue.
      </Text>

      <Stack gap="sm">
        <Paper p="md" withBorder style={{ cursor: "pointer" }} onClick={() => onSelect("resume")}>
          <Stack gap="xs">
            <Text fw={600}>Create Starkeep Cloud Admin Account</Text>
            <Text size="sm" c="dimmed">
              First time here? Enter your CloudFormation stack outputs and create your admin account.
            </Text>
          </Stack>
        </Paper>

        <Paper p="md" withBorder style={{ cursor: "pointer" }} onClick={() => onSelect("signin")}>
          <Stack gap="xs">
            <Text fw={600}>Sign In to Starkeep Cloud Admin</Text>
            <Text size="sm" c="dimmed">
              You already have an admin account. Sign in and finish setting up, or connect a new
              device.
            </Text>
          </Stack>
        </Paper>
      </Stack>

      <Divider />

      <Anchor
        size="sm"
        c="dimmed"
        onClick={() => setShowClearPanel((v) => !v)}
        style={{ cursor: "pointer" }}
      >
        Start over — clear existing bootstrap
      </Anchor>

      <Collapse in={showClearPanel}>
        <Paper p="md" withBorder>
          <Stack gap="sm">
            <Text fw={500} c="red">
              Clear your existing bootstrap stack
            </Text>
            <Text size="sm" c="dimmed">
              Use this if you want to wipe your existing Starkeep bootstrap and start fresh. This
              must be done manually in the AWS console — follow the steps below.
            </Text>

            <Group grow>
              <TextInput
                label="AWS Region"
                value={clearRegion}
                onChange={(e) => setClearRegion(e.currentTarget.value)}
                placeholder="us-east-1"
                size="sm"
              />
              <TextInput
                label="Stack prefix"
                value={clearPrefix}
                onChange={(e) => setClearPrefix(e.currentTarget.value.toLowerCase())}
                placeholder="starkeep"
                size="sm"
              />
            </Group>

            <Text size="sm">
              <strong>Steps to delete your bootstrap:</strong>
            </Text>
            <Stack gap={4} pl="md">
              <Text size="sm">1. Open the AWS CloudFormation console (button below).</Text>
              <Text size="sm">
                2. Find the stack named <Code>{clearPrefix}-bootstrap</Code>, select it, and choose{" "}
                <strong>Delete</strong>. Wait for deletion to complete (1–2 minutes).
              </Text>
              <Text size="sm">
                3. Delete the S3 bucket named <Code>{clearPrefix}-deploy-artifacts</Code> —
                CloudFormation cannot delete non-empty buckets, so empty and delete it manually
                from the S3 console.
              </Text>
              <Text size="sm">
                4. Return to the bootstrap app to re-deploy the bootstrap stack, then come back here.
              </Text>
            </Stack>

            <Button
              variant="light"
              color="red"
              size="sm"
              onClick={() =>
                openUrl(
                  `https://${clearRegion}.console.aws.amazon.com/cloudformation/home?region=${clearRegion}#/stacks`,
                )
              }
              disabled={!clearRegion}
            >
              Open CloudFormation console ({clearRegion || "select region"})
            </Button>
          </Stack>
        </Paper>
      </Collapse>
    </Stack>
  );
}
