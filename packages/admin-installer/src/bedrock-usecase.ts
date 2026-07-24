/**
 * Foundational, one-time account setup for the capability broker (plan §3.6):
 * submit the Bedrock provider use-case-details form so on-demand invoke of gated
 * models (notably Anthropic) is permitted. Without it, a live invoke 502s with
 * "Model use case details have not been submitted for this account."
 *
 * Account-global (not per-app, not per-region-scoped), so it runs ONCE during
 * the cloud-data-server foundational install under Manager creds and is
 * idempotent: GET the form; PUT it only if absent. Form-free models (e.g. Amazon
 * Nova) work regardless — this only unblocks the gated providers.
 */

import {
  BedrockClient,
  GetUseCaseForModelAccessCommand,
  PutUseCaseForModelAccessCommand,
} from "@aws-sdk/client-bedrock";
import type { AwsCredentials } from "./session";

/** The submitted use-case details. Kept deliberately truthful and minimal. */
const USE_CASE_FORM = {
  companyName: "Starkeep",
  companyWebsite: "https://starkeep.app",
  intendedUsers: "1",
  industryOption: "Others",
  otherIndustryOption: "Personal software",
  useCases: "Applying AI to personal data for building personal-use apps",
} as const;

/**
 * Ensure the Bedrock use-case form is on file for the account. Safe to call on
 * every install — it no-ops when the form already exists. The API stores the
 * form as the UTF-8 bytes of base64(JSON) (confirmed against a live submission),
 * so the blob is encoded that way here.
 */
export async function ensureBedrockUseCaseForm(input: {
  region: string;
  credentials: AwsCredentials;
}): Promise<"submitted" | "already-present"> {
  const client = new BedrockClient({
    region: input.region,
    credentials: {
      accessKeyId: input.credentials.accessKeyId,
      secretAccessKey: input.credentials.secretAccessKey,
      sessionToken: input.credentials.sessionToken,
    },
  });

  try {
    await client.send(new GetUseCaseForModelAccessCommand({}));
    return "already-present";
  } catch (err) {
    // "not filled out yet" is the only case we proceed to submit on.
    if ((err as { name?: string }).name !== "ResourceNotFoundException") throw err;
  }

  const formData = new TextEncoder().encode(
    Buffer.from(JSON.stringify(USE_CASE_FORM)).toString("base64"),
  );
  await client.send(new PutUseCaseForModelAccessCommand({ formData }));
  return "submitted";
}
