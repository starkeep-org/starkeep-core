/// <reference path="./.sst/platform/config.d.ts" />

// The return type matches StarkeepCoreOutputs from @starkeep/infra-core.
// App stacks consume these values as SST secrets injected by the admin layer.
export default $config({
  app(input) {
    return {
      name: "starkeep-core",
      removal: input?.stage === "prod" ? "retain" : "remove",
      home: "aws",
      providers: {
        aws: { region: "us-east-1" },
      },
    };
  },
  async run() {
    const stage = $app.stage;

    const cluster = new aws.dsql.Cluster(`starkeep-db-${stage}`, {
      deletionProtectionEnabled: stage === "prod",
      tags: { Stage: stage, "starkeep:managed": "true" },
    });

    const bucket = new sst.aws.Bucket(`starkeep-files-${stage}`, {
      versioning: false,
    });

    // Outputs are typed as StarkeepCoreOutputs (from @starkeep/infra-core).
    // App sst.config.ts files read these via sst.Secret and pass them to their
    // Lambda environments at deploy time.
    return {
      auroraHostname: cluster.endpoint,
      bucketName: bucket.name,
      region: "us-east-1",
    };
  },
});
