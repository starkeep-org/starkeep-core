/**
 * The custom-domain suite's env contract, on top of `@starkeep/e2e-aws`'s.
 *
 *   STARKEEP_AWS_TESTS=1                 enable the cloud suites (required)
 *   STARKEEP_AWS_CUSTOM_DOMAIN_ZONE      the dedicated public Route53 zone the
 *                                        suite writes its records in, such as
 *                                        e2e.example.com. Set it up once with
 *                                        scripts/setup-e2e-dns-zone.sh. Unset,
 *                                        the suite reports skipped and makes no
 *                                        AWS call: custom domains are optional,
 *                                        and the variable is the opt-in.
 *
 * STARKEEP_AWS_STACK_PREFIX, STARKEEP_AWS_REGION and STARKEEP_AWS_TEARDOWN work
 * as in the journey, and the suite shares the journey's run-state directory, so
 * it reuses a stack a journey run kept warm.
 *
 * The repository's .env is loaded first, so the zone can live there beside the
 * operator's other settings.
 */
import "@starkeep/app-client/load-env";
import { AWS_TESTS_ENABLED } from "@starkeep/e2e-aws";

export const CUSTOM_DOMAIN_ZONE = process.env.STARKEEP_AWS_CUSTOM_DOMAIN_ZONE?.trim()
  .toLowerCase()
  .replace(/\.$/, "");

export const CUSTOM_DOMAIN_SUITE_ENABLED = AWS_TESTS_ENABLED && !!CUSTOM_DOMAIN_ZONE;
