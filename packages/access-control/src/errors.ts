import { StarkeepError } from "@starkeep/core";

export class AccessDeniedError extends StarkeepError {
  constructor(message: string) {
    super(message, "ACCESS_DENIED");
    this.name = "AccessDeniedError";
  }
}

export class PolicyNotFoundError extends StarkeepError {
  constructor(policyId: string) {
    super(`Policy not found: ${policyId}`, "POLICY_NOT_FOUND");
    this.name = "PolicyNotFoundError";
  }
}
