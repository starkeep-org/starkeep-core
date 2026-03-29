/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "starkeep-tasks",
      removal: input?.stage === "prod" ? "retain" : "remove",
      home: "aws",
      providers: {
        aws: { region: "us-east-1" },
      },
    };
  },
  async run() {
    const stage = $app.stage;

    const cluster = new aws.dsql.Cluster(`tasks-db-${stage}`, {
      deletionProtectionEnabled: stage === "prod",
      tags: { Stage: stage, App: "starkeep-tasks" },
    });

    const bucket = new sst.aws.Bucket(`tasks-files-${stage}`, {
      versioning: false,
    });

    return {
      auroraHostname: cluster.endpoint,
      bucketName: bucket.name,
      region: "us-east-1",
    };
  },
});
