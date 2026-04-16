/**
 * Starkeeper Control Plane - SST Configuration
 *
 * Cross-account infrastructure control plane for plan-approve-deploy workflow.
 * Manages CloudFormation deployments in target AWS accounts via AssumeRole.
 * Works for managing your own accounts or customer accounts using the same security model.
 */

export default $config({
  app(input?: { stage?: string }) {
    return {
      name: "starkeeper",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
    };
  },
  async run() {
    // VPC for control plane (optional, but recommended for production)
    const vpc = process.env.USE_VPC === "true"
      ? new sst.aws.Vpc("ControlPlaneVpc", {
          nat: $app.stage === "production" ? "managed" : "ec2",
        })
      : undefined;

    // Database
    let database;
    let databaseUrl: string;

    if (process.env.DATABASE_URL) {
      // Use existing database
      databaseUrl = process.env.DATABASE_URL;
    } else if (process.env.USE_AURORA === "true" && vpc) {
      // Create Aurora Serverless v2
      database = new sst.aws.Postgres("Database", {
        vpc,
        scaling: {
          min: process.env.DB_MIN_CAPACITY || "0.5 ACU",
          max: process.env.DB_MAX_CAPACITY || "4 ACU",
        },
      });
      databaseUrl = database.url;
    } else {
      // Placeholder - user must provide DATABASE_URL
      databaseUrl = "postgresql://user:pass@localhost:5432/starkeeper";
    }

    // S3 bucket for CloudFormation templates and deployment artifacts
    // Per-customer template storage with public read access for CloudFormation
    const artifactsBucket = new sst.aws.Bucket("ArtifactsBucket", {
      versioning: true,
      public: true, // Templates need to be accessible by CloudFormation
      cors: [
        {
          allowedOrigins: ["*"],
          allowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
          allowedHeaders: ["*"],
          maxAge: 3000,
        },
      ],
    });

    // Get AWS account ID
    const awsAccountId = await aws.getCallerIdentity({});

    // Migration Lambda (runs in VPC to access database)
    const migrationLambda = database ? new sst.aws.Function("MigrationFunction", {
      handler: "packages/db/scripts/migrate-lambda.handler",
      runtime: "nodejs20.x",
      timeout: "5 minutes",
      vpc,
      environment: {
        DATABASE_URL: databaseUrl,
      },
      nodejs: {
        install: ["pg"],
      },
    }) : undefined;

    // TODO: Re-enable Remix app once AWS account is verified for CloudFront
    // const remix = new sst.aws.Remix("RemixApp", {
    //   path: "../admin-remix",
    //   link: [artifactsBucket],
    //   environment: {
    //     DATABASE_URL: databaseUrl,
    //     ARTIFACTS_BUCKET: artifactsBucket.name,
    //     AWS_ACCOUNT_ID: awsAccountId.accountId,
    //   },
    //   domain: process.env.DOMAIN_NAME ? {
    //     name: process.env.DOMAIN_NAME,
    //     dns: sst.aws.dns({
    //       zone: process.env.ROUTE53_ZONE_ID,
    //     }),
    //   } : undefined,
    // });

    return {
      // remixUrl: remix.url,
      artifactsBucket: artifactsBucket.name,
      databaseUrl: databaseUrl,
      accountId: awsAccountId.accountId,
      migrationFunction: migrationLambda?.name,
    };
  },
});
