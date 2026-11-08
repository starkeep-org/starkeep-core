/**
 * Custom domains against real AWS and real DNS.
 *
 * Unit tests and the IAM simulator use inputs the test supplies. This suite
 * proves what only the real services can: that ACM issues through real DNS
 * validation and CloudFront accepts the certificate and the alias; that IAM's
 * record-name condition admits Route53's own normalization of real requests;
 * that the narrowed temp-policy wildcards admit every call Pulumi makes; that
 * PutRolePolicy takes the two-domain temp policy; that sessions work on both
 * hosts in a real browser; that the preflight reads real ListResourceRecordSets
 * output; and that the teardown script deletes what an attach created.
 *
 * Every per-run record lands in the operator's dedicated test zone
 * (STARKEEP_AWS_CUSTOM_DOMAIN_ZONE), under names unique to the run. The
 * README's "Safety" section lists the layers that keep the run away from live
 * resources; the preconditions and postconditions below are two of them.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import {
  CliFailure,
  REGION,
  STACK_PREFIX,
  TEARDOWN,
  chromium,
  cloudAppTokens,
  ensureBootstrapStack,
  probeApp,
  readConfig,
  runInstallCli,
  runPaths,
  runTeardownScript,
  signInTestAdmin,
  signInWithBrowser,
  stackConfigFrom,
  watchPageProblems,
  writeConfig,
  type AdminCredentials,
  type AdminSession,
  type Browser,
  type TestStackConfig,
} from "@starkeep/e2e-aws";
import {
  findHostedZone,
  type CustomDomainStatus,
  type KeptCertificate,
} from "@starkeep/admin-installer/custom-domain";
import { createRecordWithBytes, solidPng, type LdsApp } from "@starkeep/e2e";
import { signedFetch, USER_TOKEN_HEADER, type AppCredentials } from "@starkeep/app-client";
import { CUSTOM_DOMAIN_SUITE_ENABLED, CUSTOM_DOMAIN_ZONE } from "./env.js";
import {
  TestZoneWriter,
  ambientCredentials,
  certificatesFor,
  distributionServing,
  foreignToSuite,
  normalizeName,
  parentZoneOf,
  publiclyDelegated,
  recordSets,
  recordSetsText,
  recordsAtOrUnder,
  zoneNamed,
  type ZoneRef,
} from "./zone.js";

type Config = TestStackConfig & {
  customDomain?: string;
  customDomainStatus?: CustomDomainStatus;
  customDomainAttempted?: string;
  customDomainKept?: KeptCertificate;
  cloudfrontDomain?: string;
};

const ZONE = CUSTOM_DOMAIN_ZONE ?? "";
const RUN_ID = randomBytes(3).toString("hex");
const RUN_PREFIX = `${STACK_PREFIX}-${RUN_ID}`;
const FIRST = `${RUN_PREFIX}.${ZONE}`;
const SECOND = `${RUN_PREFIX}-b.${ZONE}`;
/** TEST-NET-1: routes nowhere. */
const FOREIGN_ADDRESS = "192.0.2.1";

/** The operator's own deployments, which the run must leave exactly as it found them. */
function liveConfigs(): Array<{ path: string; config: Config }> {
  const paths = new Set([join(homedir(), ".starkeep", "config.json")]);
  if (process.env.STARKEEP_DIR) paths.add(join(process.env.STARKEEP_DIR, "config.json"));
  return [...paths]
    .filter((p) => existsSync(p))
    .map((path) => ({ path, config: JSON.parse(readFileSync(path, "utf-8")) as Config }));
}

/**
 * What the run must not change outside the test zone: the parent zone's record
 * sets, and each live deployment's custom domain, its records and its
 * certificate.
 */
async function snapshotOutsideTestZone(parent: ZoneRef | null): Promise<string> {
  const parts: string[] = [];
  if (parent) parts.push(`zone ${parent.name}\n${recordSetsText(await recordSets(parent.id))}`);
  for (const { path, config } of liveConfigs()) {
    const domain = config.customDomainStatus?.name ?? config.customDomain;
    if (!domain) continue;
    const zone = await longestZoneFor(domain);
    const records = zone ? recordSetsText(recordsAtOrUnder(await recordSets(zone.id), domain)) : "";
    const certificates = (await certificatesFor([domain])).map((c) =>
      JSON.stringify({ arn: c.arn, status: c.status, inUseBy: c.inUseBy }),
    );
    parts.push(`live ${path}: ${domain}\n${records}\n${certificates.join("\n")}`);
  }
  return parts.join("\n\n");
}

async function longestZoneFor(domain: string): Promise<ZoneRef | null> {
  return (await zoneNamed(domain)) ?? (await parentZoneOf(domain));
}

/** Retry a fetch through DNS propagation and CloudFront deployment. */
async function fetchEventually(
  url: string,
  init?: RequestInit,
  ok: (r: Response) => boolean = (r) => r.status < 500,
  attempts = 60,
): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (ok(res)) return res;
      last = new Error(`${res.status} from ${url}`);
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error(`${url} never answered as expected: ${String(last)}`);
}

(CUSTOM_DOMAIN_SUITE_ENABLED ? describe : describe.skip)(
  `custom domains in ${ZONE} (prefix ${STACK_PREFIX}, run ${RUN_ID})`,
  () => {
    // The journey's run-state directory, so a stack a journey run kept warm
    // serves this suite too.
    const paths = runPaths(STACK_PREFIX);
    let zone: ZoneRef;
    let writer: TestZoneWriter;
    let parent: ZoneRef | null = null;
    let before: string | undefined;
    let config: Config;
    let admin: AdminCredentials;
    let session: AdminSession;
    let anyFailed = false;

    afterEach((ctx) => {
      if (ctx.task.result?.state === "fail") anyFailed = true;
    });

    beforeAll(() => {
      // A throw here skips every step; the run still counts as failed.
      anyFailed = true;
      expect(ZONE).not.toBe("");
      anyFailed = false;
    });

    // Postconditions. They run whatever happened above, and only read: a
    // failed run tears nothing down, and leaves the stack for inspection.
    afterAll(async () => {
      if (anyFailed) {
        console.log(
          "[custom-domain] run failed; leaving the test stack and its records up for debugging. " +
            `Records for this run sit under ${RUN_PREFIX}*.${ZONE}.`,
        );
      }
      if (before === undefined) return;
      const after = await snapshotOutsideTestZone(parent);
      expect(after, "the run changed DNS or a certificate outside the test zone").toBe(before);
    });

    function writeDomain(domain: string | undefined): void {
      config = readConfig(paths) as Config;
      if (domain) config.customDomain = domain;
      else delete config.customDomain;
      writeConfig(paths, config);
    }

    async function installCloudDataServer(): Promise<string> {
      const output = await runInstallCli(
        "cli-install-cloud-data-server",
        ["--ephemeral"],
        paths,
        session,
      );
      config = readConfig(paths) as Config;
      return output;
    }

    /** This deployment's certificates for `domain`. */
    async function stackCertificates(domain: string) {
      return (await certificatesFor([domain])).filter(
        (c) => c.tags["starkeep:stackPrefix"] === STACK_PREFIX,
      );
    }

    /** Assert that nothing of `domain` is left: no record, and no certificate. */
    async function expectGone(domain: string): Promise<void> {
      const left = recordsAtOrUnder(await recordSets(zone.id), domain);
      expect(left.map((r) => `${r.Type} ${normalizeName(r.Name ?? "")}`)).toEqual([]);
      expect(await stackCertificates(domain)).toEqual([]);
    }

    /**
     * Assert that a removal kept `domain`'s certificate on the distribution,
     * with no alias and no A record, and kept the validation record so the
     * certificate keeps renewing. ACM holds a certificate for up to an hour
     * after CloudFront falls back to its default certificate, so a removal
     * never takes that path.
     */
    async function expectKept(domain: string): Promise<void> {
      const atOrUnder = recordsAtOrUnder(await recordSets(zone.id), domain);
      expect(atOrUnder.filter((r) => normalizeName(r.Name ?? "") === domain)).toEqual([]);
      expect(atOrUnder.map((r) => r.Type)).toEqual(["CNAME"]);
      const certificates = await stackCertificates(domain);
      expect(certificates).toHaveLength(1);
      const serving = await distributionServing(config.cloudfrontDomain!);
      expect(serving.aliases).not.toContain(domain);
      expect(serving.certificateArn).toBe(certificates[0]!.arn);
      expect(config.customDomainKept).toMatchObject({ name: domain, mode: "route53" });
    }

    /** Assert that `domain` is attached in Route53 mode and serves the cloud. */
    async function expectAttached(domain: string): Promise<void> {
      expect(config.customDomainStatus).toMatchObject({
        name: domain,
        mode: "route53",
        status: "active",
      });
      expect(config.publicBaseUrl).toBe(`https://${domain}`);
      const [certificate] = await stackCertificates(domain);
      expect(certificate?.status).toBe("ISSUED");

      const atName = recordsAtOrUnder(await recordSets(zone.id), domain).filter(
        (r) => normalizeName(r.Name ?? "") === domain,
      );
      expect(atName.map((r) => r.Type)).toEqual(["A"]);
      expect(normalizeName(atName[0]!.AliasTarget?.DNSName ?? "")).toBe(config.cloudfrontDomain);

      const res = await fetchEventually(`https://${domain}/apps/${probeApp.appId}`);
      expect((res.headers.get("via") ?? "").toLowerCase()).toContain("cloudfront");
    }

    // ---- 1. Preconditions ---------------------------------------------------

    it("refuses to start anywhere but a dedicated, delegated test zone", async () => {
      for (const { path, config: live } of liveConfigs()) {
        expect(
          live.stackPrefix,
          `${path} is a live deployment with the test prefix ${STACK_PREFIX}`,
        ).not.toBe(STACK_PREFIX);
      }

      const found = await zoneNamed(ZONE);
      expect(found, `the account holds no public zone named ${ZONE}`).not.toBeNull();
      zone = found!;
      expect(
        await publiclyDelegated(zone),
        `public DNS does not delegate ${ZONE}; run scripts/setup-e2e-dns-zone.sh ${ZONE}`,
      ).toBe(true);

      const foreign = foreignToSuite(await recordSets(zone.id), ZONE, STACK_PREFIX);
      expect(foreign, `${ZONE} serves records the suite did not write`).toEqual([]);

      // Each code path picks the longest zone that ends a name; the test names
      // must resolve to the test zone, never to its parent.
      const creds = await ambientCredentials(REGION);
      for (const name of [FIRST, SECOND]) {
        expect((await findHostedZone(name, creds))?.id).toBe(zone.id);
      }

      writer = new TestZoneWriter(zone, RUN_PREFIX);
      parent = await parentZoneOf(ZONE);
      before = await snapshotOutsideTestZone(parent);
    });

    it("brings up the test stack's bootstrap layer and signs the admin in", async () => {
      const { outputs } = await ensureBootstrapStack({ stackPrefix: STACK_PREFIX, region: REGION });
      config = stackConfigFrom(readConfig(paths), STACK_PREFIX, outputs, probeApp.appDir);
      writeConfig(paths, config);
      ({ admin, session } = await signInTestAdmin(paths, config));
    });

    // ---- 2. Preflight refusal -----------------------------------------------

    it("refuses a domain that already holds a record the stack did not write", async () => {
      const foreign = {
        Name: `${FIRST}.`,
        Type: "A" as const,
        TTL: 60,
        ResourceRecords: [{ Value: FOREIGN_ADDRESS }],
      };
      await writer.create(foreign);
      try {
        writeDomain(FIRST);
        const failure = await installCloudDataServer().then(
          () => undefined,
          (err: unknown) => err,
        );
        expect(failure, "the install attached a domain that held a foreign record").toBeInstanceOf(
          CliFailure,
        );
        expect((failure as CliFailure).output).toContain(`A ${FIRST} (${FOREIGN_ADDRESS})`);
        expect(await stackCertificates(FIRST)).toEqual([]);
      } finally {
        await writer.delete(foreign);
      }
    });

    // ---- 3. Attach ----------------------------------------------------------

    it("attaches the first name: certificate issued, one A alias, canonical", async () => {
      writeDomain(FIRST);
      await installCloudDataServer();
      await expectAttached(FIRST);

      const parameter = await new SSMClient({ region: REGION }).send(
        new GetParameterCommand({
          Name: `/${STACK_PREFIX}/app-creds/_cloudfront-signing`,
          WithDecryption: true,
        }),
      );
      const signing = JSON.parse(parameter.Parameter!.Value!) as {
        domain: string;
        hosts: string[];
      };
      expect(signing.domain).toBe(FIRST);
      expect(signing.hosts).toEqual([FIRST, config.cloudfrontDomain]);
    });

    it("installs the probe app in the cloud", async () => {
      await runInstallCli("cli-install-app", [probeApp.appId], paths, session);
    });

    // ---- 4. Sessions on both hosts ------------------------------------------

    describe("sessions on both hosts, in a real browser", () => {
      let browser: Browser;
      beforeAll(async () => {
        browser = await chromium.launch();
      });
      afterAll(async () => {
        await browser?.close();
      });

      for (const which of ["custom domain", "cloudfront.net name"] as const) {
        it(`signs in, refreshes and signs out on the ${which}`, async () => {
          const host = which === "custom domain" ? FIRST : config.cloudfrontDomain!;
          const appUrl = `https://${host}/apps/${probeApp.appId}/`;
          const context = await browser.newContext();
          const page = await context.newPage();
          const problems = watchPageProblems(page);
          try {
            // An anonymous page goes to the app's sign-in page on the same host.
            await fetchEventually(appUrl);
            await page.goto(appUrl, { waitUntil: "load" });
            expect(new URL(page.url()).host).toBe(host);
            await page.getByRole("button", { name: "Sign in" }).waitFor({ timeout: 30_000 });

            // A sign-in that begins on this host finishes on it.
            await signInWithBrowser({
              page,
              appUrl,
              email: admin.email,
              password: admin.password,
              signedInControl: probeApp.browser!.signedInControl,
              problemReport: problems,
            });
            expect(new URL(page.url()).host).toBe(host);

            // Refresh: drop the short-lived token, as its expiry would, and let
            // the page's own POST mint another from sk_session. The request
            // carries this host's Origin, which the CSRF check must accept.
            await context.clearCookies({ name: "sk_token" });
            const refreshed = await page.evaluate(
              async (path) => (await fetch(path, { method: "POST" })).status,
              `/apps/${probeApp.appId}/api/session/refresh`,
            );
            expect(refreshed, problems()).toBe(200);
            expect((await context.cookies()).some((c) => c.name === "sk_token")).toBe(true);

            const signedOut = await page.evaluate(
              async (path) => (await fetch(path, { method: "POST" })).status,
              `/apps/${probeApp.appId}/api/session/sign-out`,
            );
            expect(signedOut, problems()).toBe(200);

            // A page on another site is refused, whatever cookies it rides on.
            const foreign = await fetch(
              `https://${host}/apps/${probeApp.appId}/api/session/refresh`,
              {
                method: "POST",
                headers: { origin: "https://evil.example" },
              },
            );
            expect(foreign.status).toBe(403);
          } finally {
            await context.close();
          }
        });
      }
    });

    // ---- 5. Signed bytes on the custom host ---------------------------------

    it("mints signed URLs on the custom host, and the edge enforces them", async () => {
      const secret = await new SSMClient({ region: REGION }).send(
        new GetParameterCommand({
          Name: `/${STACK_PREFIX}/app-creds/${probeApp.appId}`,
          WithDecryption: true,
        }),
      );
      const creds: AppCredentials = {
        appId: probeApp.appId,
        hmacSecret: (JSON.parse(secret.Parameter!.Value!) as { hmacSecret: string }).hmacSecret,
        dataServerUrl: `${config.apiGatewayUrl}/apps/${probeApp.appId}`,
      };
      const { idToken } = await cloudAppTokens(config, admin.email, admin.password);
      const cloudProbe: LdsApp = {
        ...creds,
        fetch: (path, init) =>
          signedFetch(creds, path, {
            ...init,
            headers: { ...(init?.headers ?? {}), [USER_TOKEN_HEADER]: idToken },
          }),
      };

      const bytes = solidPng([...randomBytes(3)] as [number, number, number], 24);
      const { record } = await createRecordWithBytes(cloudProbe, { bytes });
      const minted = await cloudProbe.fetch(`/data/records/${record.id}/file-url`);
      expect(minted.status).toBe(200);
      const { url } = (await minted.json()) as { url: string };
      const signed = new URL(url);
      expect(signed.host).toBe(FIRST);

      const res = await fetchEventually(url, undefined, (r) => r.status === 200);
      expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);

      const tampered = new URL(url);
      const signature = tampered.searchParams.get("Signature")!;
      tampered.searchParams.set(
        "Signature",
        (signature[0] === "A" ? "B" : "A") + signature.slice(1),
      );
      expect((await fetch(tampered)).status).toBe(403);
      expect((await fetch(`https://${FIRST}${signed.pathname}`)).status).toBe(403);
    });

    // ---- 6. Change ----------------------------------------------------------

    it("changes to the second name and deletes everything of the first", async () => {
      writeDomain(SECOND);
      await installCloudDataServer();
      await expectAttached(SECOND);
      await expectGone(FIRST);
    });

    // ---- 7. Removal ---------------------------------------------------------

    it("removes the domain and returns to the cloudfront.net name", async () => {
      writeDomain(undefined);
      await installCloudDataServer();
      expect(config.customDomainStatus).toBeUndefined();
      expect(config.publicBaseUrl).toBe(`https://${config.cloudfrontDomain}`);
      await expectKept(SECOND);
    });

    // ---- 8. Teardown with a domain attached ---------------------------------

    it(
      "tears the stack down with a domain attached and leaves nothing of it",
      async () => {
        if (TEARDOWN === "none") {
          console.log(
            "[custom-domain] STARKEEP_AWS_TEARDOWN=none; keeping the stack, with the removed name's certificate kept",
          );
          return;
        }
        // The attach swaps the kept certificate out, and the same install
        // deletes it with its validation record.
        writeDomain(FIRST);
        await installCloudDataServer();
        await expectAttached(FIRST);
        await expectGone(SECOND);
        expect(config.customDomainKept).toBeUndefined();
        // The teardown deletes the distribution, which releases its
        // certificate at once, then every certificate of the stack.
        runTeardownScript(
          TEARDOWN === "all" ? "teardown-bootstrap.sh" : "teardown-cloud-data-server.sh",
          paths,
        );
        await expectGone(FIRST);
        await expectGone(SECOND);
      },
      90 * 60_000,
    );
  },
);
